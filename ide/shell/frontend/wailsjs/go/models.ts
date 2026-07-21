export namespace main {
	
	export class GitBranch {
	    name: string;
	    current: boolean;
	    remote: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitBranch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.current = source["current"];
	        this.remote = source["remote"];
	    }
	}
	export class GitDiff {
	    path: string;
	    original: string;
	    modified: string;
	    staged: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitDiff(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.original = source["original"];
	        this.modified = source["modified"];
	        this.staged = source["staged"];
	    }
	}
	export class GitFileStatus {
	    path: string;
	    original_path?: string;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new GitFileStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.original_path = source["original_path"];
	        this.status = source["status"];
	    }
	}
	export class GitHubCommit {
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new GitHubCommit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.message = source["message"];
	    }
	}
	export class GitHubPR {
	    exists: boolean;
	    number: number;
	    title: string;
	    author: string;
	    url: string;
	    check_status: string;
	
	    static createFrom(source: any = {}) {
	        return new GitHubPR(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.exists = source["exists"];
	        this.number = source["number"];
	        this.title = source["title"];
	        this.author = source["author"];
	        this.url = source["url"];
	        this.check_status = source["check_status"];
	    }
	}
	export class GitHubPRListItem {
	    number: number;
	    title: string;
	    author: string;
	    head_branch: string;
	    url: string;
	
	    static createFrom(source: any = {}) {
	        return new GitHubPRListItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.number = source["number"];
	        this.title = source["title"];
	        this.author = source["author"];
	        this.head_branch = source["head_branch"];
	        this.url = source["url"];
	    }
	}
	export class GitHubStatus {
	    available: boolean;
	    authenticated: boolean;
	    login: string;
	    reason: string;
	    is_github_remote: boolean;
	
	    static createFrom(source: any = {}) {
	        return new GitHubStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.authenticated = source["authenticated"];
	        this.login = source["login"];
	        this.reason = source["reason"];
	        this.is_github_remote = source["is_github_remote"];
	    }
	}
	export class GitStatus {
	    root: string;
	    branch: string;
	    ahead: number;
	    behind: number;
	    changes: GitFileStatus[];
	    staged: GitFileStatus[];
	    conflicts: GitFileStatus[];
	    ignored: GitFileStatus[];
	
	    static createFrom(source: any = {}) {
	        return new GitStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.root = source["root"];
	        this.branch = source["branch"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.changes = this.convertValues(source["changes"], GitFileStatus);
	        this.staged = this.convertValues(source["staged"], GitFileStatus);
	        this.conflicts = this.convertValues(source["conflicts"], GitFileStatus);
	        this.ignored = this.convertValues(source["ignored"], GitFileStatus);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LocalTerminalInfo {
	    id: string;
	    name: string;
	    cwd: string;
	    shell: string;
	
	    static createFrom(source: any = {}) {
	        return new LocalTerminalInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.cwd = source["cwd"];
	        this.shell = source["shell"];
	    }
	}
	export class ProviderKeyStatus {
	    env_path: string;
	    active_provider: string;
	    configured: Record<string, boolean>;
	    default_model: string;
	    known_providers: string[];
	
	    static createFrom(source: any = {}) {
	        return new ProviderKeyStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.env_path = source["env_path"];
	        this.active_provider = source["active_provider"];
	        this.configured = source["configured"];
	        this.default_model = source["default_model"];
	        this.known_providers = source["known_providers"];
	    }
	}
	export class SearchMatch {
	    path: string;
	    line: number;
	    column: number;
	    preview: string;
	
	    static createFrom(source: any = {}) {
	        return new SearchMatch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.line = source["line"];
	        this.column = source["column"];
	        this.preview = source["preview"];
	    }
	}
	export class WorkspaceInfo {
	    name: string;
	    path: string;
	
	    static createFrom(source: any = {}) {
	        return new WorkspaceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	    }
	}

}

export namespace session {
	
	export class BudgetUpdate {
	    phase: string;
	    spent: number;
	    allocated: number;
	
	    static createFrom(source: any = {}) {
	        return new BudgetUpdate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.phase = source["phase"];
	        this.spent = source["spent"];
	        this.allocated = source["allocated"];
	    }
	}
	export class TestResult {
	    name: string;
	    passed: boolean;
	
	    static createFrom(source: any = {}) {
	        return new TestResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.passed = source["passed"];
	    }
	}
	export class ContractEntry {
	    contract_id: string;
	    phase: string;
	    agent: string;
	    intent: string;
	    diff_refs: string[];
	    reasoning: string;
	    risks: string[];
	    tests_run: TestResult[];
	    side_effect_tier: string;
	    approved_by?: string;
	    created_at: string;
	
	    static createFrom(source: any = {}) {
	        return new ContractEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.contract_id = source["contract_id"];
	        this.phase = source["phase"];
	        this.agent = source["agent"];
	        this.intent = source["intent"];
	        this.diff_refs = source["diff_refs"];
	        this.reasoning = source["reasoning"];
	        this.risks = source["risks"];
	        this.tests_run = this.convertValues(source["tests_run"], TestResult);
	        this.side_effect_tier = source["side_effect_tier"];
	        this.approved_by = source["approved_by"];
	        this.created_at = source["created_at"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CostReport {
	    total_spent: number;
	    total_allocated: number;
	    by_phase: BudgetUpdate[];
	
	    static createFrom(source: any = {}) {
	        return new CostReport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.total_spent = source["total_spent"];
	        this.total_allocated = source["total_allocated"];
	        this.by_phase = this.convertValues(source["by_phase"], BudgetUpdate);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class FileContent {
	    path: string;
	    content: string;
	
	    static createFrom(source: any = {}) {
	        return new FileContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.content = source["content"];
	    }
	}
	export class FileNode {
	    name: string;
	    path: string;
	    is_dir: boolean;
	    children?: FileNode[];
	
	    static createFrom(source: any = {}) {
	        return new FileNode(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.is_dir = source["is_dir"];
	        this.children = this.convertValues(source["children"], FileNode);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class SessionSummary {
	    session_id: string;
	    goal: string;
	    topology: string;
	    mode: string;
	    status: string;
	    started_at: string;
	    ended_at?: string;
	
	    static createFrom(source: any = {}) {
	        return new SessionSummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.session_id = source["session_id"];
	        this.goal = source["goal"];
	        this.topology = source["topology"];
	        this.mode = source["mode"];
	        this.status = source["status"];
	        this.started_at = source["started_at"];
	        this.ended_at = source["ended_at"];
	    }
	}
	export class StartSessionResult {
	    session_id: string;
	    ws_url: string;
	
	    static createFrom(source: any = {}) {
	        return new StartSessionResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.session_id = source["session_id"];
	        this.ws_url = source["ws_url"];
	    }
	}
	
	export class TraceEntry {
	    seq: number;
	    ts: string;
	    type: string;
	    payload: any;
	
	    static createFrom(source: any = {}) {
	        return new TraceEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.seq = source["seq"];
	        this.ts = source["ts"];
	        this.type = source["type"];
	        this.payload = source["payload"];
	    }
	}

}

