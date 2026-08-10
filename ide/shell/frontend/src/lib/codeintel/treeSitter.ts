// Frontend half of the Live Code Intelligence Engine's TypeScript adapter.
//
// Tree-sitter parsing lives here rather than in Go because this app builds
// with CGO disabled (verified: `go env CGO_ENABLED` -> 0, no gcc on PATH),
// and the standard Go tree-sitter bindings need CGO. web-tree-sitter (the
// official WASM build) runs directly inside the WebView2 runtime instead --
// no native toolchain needed. This module owns Section 4's per-language
// structural extraction (symbols/edges) and Gates 1 and 3's frontend-side
// signals (syntax validity, scope-exit); everything downstream (the graph
// store, trigger-gate timing, LSP-backed resolution) is Go, reached via the
// Wails-bound CodeIntel* methods.
import { Parser, Language, Tree, Edit, type Node as TSNode, type Point } from "web-tree-sitter";

// Vite's ?url suffix resolves to the final served path for these binary
// assets (dev server or production bundle) rather than trying to import
// wasm bytes directly.
import webTreeSitterWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";
import typescriptWasmUrl from "tree-sitter-wasms/out/tree-sitter-typescript.wasm?url";

export interface Span {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
}

export type NodeKind = "function" | "class" | "route" | "import" | "variable" | "type";
export type EdgeKind = "calls" | "imports" | "extends" | "routes-to";
export type ResolutionState = "unresolved" | "pending" | "resolved" | "dangling" | "resolution-failed";

// Mirrors ide/shell/internal/codeintel/graph.go's Node/Edge JSON shape
// exactly (field names included) -- these cross the Wails bridge as-is.
export interface CINode {
  id: string;
  kind: NodeKind;
  language: string;
  file_path: string;
  span: Span;
  tier: "hot" | "warm" | "cold";
  resolution_state: ResolutionState;
}

export interface CIEdge {
  id: string;
  from: string;
  to_name: string;
  kind: EdgeKind;
  cross_language: boolean;
  confidence: number;
  resolution_state: ResolutionState;
  file_path: string;
  span: Span;
}

export interface ParseResult {
  tree: Tree;
  hasSyntaxError: boolean;
  nodes: CINode[];
  edges: CIEdge[];
}

// scope_boundary_node_types (spec §4) -- the structural signal for Gate 3.
const SCOPE_BOUNDARY_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "class_declaration",
]);

let initPromise: Promise<void> | null = null;
let tsLanguagePromise: Promise<Language> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({ locateFile: () => webTreeSitterWasmUrl });
  }
  return initPromise;
}

function getTypeScriptLanguage(): Promise<Language> {
  if (!tsLanguagePromise) {
    tsLanguagePromise = ensureInit().then(() => Language.load(typescriptWasmUrl));
  }
  return tsLanguagePromise;
}

interface FileState {
  parser: Parser;
  tree: Tree | null;
}

const files = new Map<string, FileState>();

async function getFileState(path: string): Promise<FileState> {
  let state = files.get(path);
  if (!state) {
    const parser = new Parser();
    parser.setLanguage(await getTypeScriptLanguage());
    state = { parser, tree: null };
    files.set(path, state);
  }
  return state;
}

/** Drop a file's parser/tree state -- call when it's closed in the editor. */
export function forgetFile(path: string): void {
  files.delete(path);
}

/** The most recent parse tree for path, if any -- for cursor-driven lookups (scope-exit detection) between parses. */
export function getTree(path: string): Tree | null {
  return files.get(path)?.tree ?? null;
}

// A single content-replacement edit, in the shape Monaco's
// onDidChangeModelContent already hands us per change (0-indexed row/col,
// not Monaco's 1-indexed line/column -- convert at the call site).
export interface TextEdit {
  startIndex: number;
  oldEndIndex: number;
  newIndex: number;
  startPosition: Point;
  oldEndPosition: Point;
  newEndPosition: Point;
}

/**
 * Incrementally re-parses path's buffer: applies `edits` to the previous
 * tree (if any) via Tree.edit() before reparsing, so tree-sitter only
 * re-walks the changed region rather than the whole file. Falls back to a
 * full parse automatically the first time a file is seen (no previous tree
 * to edit against).
 */
export async function parseIncremental(path: string, newText: string, edits: TextEdit[]): Promise<ParseResult> {
  const state = await getFileState(path);

  if (state.tree) {
    for (const edit of edits) {
      state.tree.edit(new Edit({
        startIndex: edit.startIndex,
        oldEndIndex: edit.oldEndIndex,
        newEndIndex: edit.newIndex,
        startPosition: edit.startPosition,
        oldEndPosition: edit.oldEndPosition,
        newEndPosition: edit.newEndPosition,
      }));
    }
  }

  const tree = state.parser.parse(newText, state.tree ?? undefined);
  if (!tree) {
    throw new Error(`tree-sitter failed to parse ${path}`);
  }
  state.tree = tree;

  const { nodes, edges } = extract(path, tree);
  return { tree, hasSyntaxError: tree.rootNode.hasError, nodes, edges };
}

/** Finds the innermost function/class/method body containing (row, col), for Gate 3's scope-exit signal. */
export function findEnclosingScope(tree: Tree, row: number, col: number): Span | null {
  let node: TSNode | null = tree.rootNode.descendantForPosition({ row, column: col });
  while (node) {
    if (SCOPE_BOUNDARY_TYPES.has(node.type)) {
      return toSpan(node);
    }
    node = node.parent;
  }
  return null;
}

function toSpan(node: TSNode): Span {
  return {
    start_line: node.startPosition.row,
    start_col: node.startPosition.column,
    end_line: node.endPosition.row,
    end_col: node.endPosition.column,
  };
}

function edgeId(kind: EdgeKind, filePath: string, refNode: TSNode): string {
  return `${kind}:${filePath}:${refNode.startIndex}`;
}

// extract walks the tree for import specifiers and simple (identifier-only)
// call expressions -- the two reference kinds v1's existence check covers.
// Member-expression calls (`foo.bar()`) and re-exports are deliberately out
// of scope for this pass; extending this walk to more node shapes doesn't
// require any change on the Go side, which only ever sees Edge/Node values.
function extract(filePath: string, tree: Tree): { nodes: CINode[]; edges: CIEdge[] } {
  const edges: CIEdge[] = [];
  const nodes: CINode[] = [];
  const moduleNodeId = `ts:${filePath}#module`;

  nodes.push({
    id: moduleNodeId,
    kind: "type",
    language: "typescript",
    file_path: filePath,
    span: toSpan(tree.rootNode),
    tier: "hot",
    resolution_state: "resolved",
  });

  const walk = (node: TSNode): void => {
    if (node.type === "import_statement") {
      const clause = node.namedChildren.find((c) => c?.type === "import_clause");
      if (clause) {
        for (const { name, node: idNode } of collectImportNames(clause)) {
          edges.push({
            id: edgeId("imports", filePath, idNode),
            from: moduleNodeId,
            to_name: name,
            kind: "imports",
            cross_language: false,
            confidence: 1,
            resolution_state: "unresolved",
            file_path: filePath,
            span: toSpan(idNode),
          });
        }
      }
    } else if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const route = fn ? extractRouteCall(fn, node) : null;
      if (route) {
        edges.push({
          id: edgeId("routes-to", filePath, fn!),
          from: moduleNodeId,
          to_name: route.method ? `${route.method} ${route.url}` : route.url,
          kind: "routes-to",
          cross_language: true,
          confidence: 1,
          resolution_state: "unresolved",
          file_path: filePath,
          span: toSpan(fn!),
        });
      } else if (fn && fn.type === "identifier") {
        edges.push({
          id: edgeId("calls", filePath, fn),
          from: moduleNodeId,
          to_name: fn.text,
          kind: "calls",
          cross_language: false,
          confidence: 1,
          resolution_state: "unresolved",
          file_path: filePath,
          span: toSpan(fn),
        });
      }
    }
    for (const child of node.children) {
      if (child) walk(child);
    }
  };
  walk(tree.rootNode);

  return { nodes, edges };
}

function collectImportNames(clause: TSNode): { name: string; node: TSNode }[] {
  const out: { name: string; node: TSNode }[] = [];
  for (const child of clause.namedChildren) {
    if (!child) continue;
    if (child.type === "identifier") {
      out.push({ name: child.text, node: child }); // default import
    } else if (child.type === "named_imports") {
      for (const spec of child.namedChildren) {
        if (spec?.type === "import_specifier") {
          const nameNode = spec.childForFieldName("name");
          if (nameNode) out.push({ name: nameNode.text, node: nameNode });
        }
      }
    }
    // namespace_import ("import * as ns") isn't a single resolvable symbol -- skip.
  }
  return out;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

// extractRouteCall recognizes the two call shapes bridge detection covers in
// v1 (spec §7's schema-backed bridge): `fetch("/url", {method: "..."})` and
// `<anything>.<httpVerb>("/url", ...)` (axios.get, api.post, client.delete,
// ...) -- the object identifier isn't checked, since real codebases name
// their HTTP client instance many different things; requiring the method
// name to be a real HTTP verb AND the first argument to be a plain string
// literal keeps the false-positive rate low without hardcoding "axios".
function extractRouteCall(fn: TSNode, call: TSNode): { method: string; url: string } | null {
  const args = call.childForFieldName("arguments");
  const firstArg = args?.namedChildren[0] ?? null;
  const url = firstArg ? stringLiteralValue(firstArg) : null;
  if (!url || !url.startsWith("/")) return null; // only same-origin API-shaped paths, not full URLs to other services

  if (fn.type === "identifier" && fn.text === "fetch") {
    const optionsArg = args?.namedChildren[1] ?? null;
    return { method: methodFromOptionsObject(optionsArg) ?? "GET", url };
  }

  if (fn.type === "member_expression") {
    const property = fn.childForFieldName("property");
    if (property && HTTP_METHODS.has(property.text.toLowerCase())) {
      return { method: property.text.toUpperCase(), url };
    }
  }
  return null;
}

function methodFromOptionsObject(node: TSNode | null): string | null {
  if (!node || node.type !== "object") return null;
  for (const pair of node.namedChildren) {
    if (pair?.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (key && value && stripQuotes(key.text) === "method") {
      const method = stringLiteralValue(value);
      return method ? method.toUpperCase() : null;
    }
  }
  return null;
}

// stringLiteralValue handles plain single/double-quoted string literals
// only -- template literals with interpolation (`/users/${id}`) can't be
// resolved to a concrete path without evaluating the expression, so they're
// deliberately left unmatched rather than guessed at.
function stringLiteralValue(node: TSNode): string | null {
  if (node.type !== "string") return null;
  const fragment = node.namedChildren.find((c) => c?.type === "string_fragment");
  return fragment ? fragment.text : stripQuotes(node.text);
}

function stripQuotes(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}
