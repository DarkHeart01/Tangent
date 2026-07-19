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

