// tests/rag.test.ts — Codebase RAG（V2 增量）的检索内核。
//
// 断言真实出货函数 tokenize / chunkFile / scoreChunk / retrieveTopK / renderInjection / lastUserText。
// 全是纯逻辑（零 API、零 IO——buildIndex 的文件遍历不在此测，属集成层），确定性、秒级。

import {
	chunkFile,
	lastUserText,
	renderInjection,
	retrieveTopK,
	scoreChunk,
	tokenize,
	type CodeChunk,
} from "../.pi/extensions/evopi-trace/rag";
import { describe, it, eq, ok, truthy } from "./harness";

describe("rag · tokenize（拆词 + 拆驼峰）", () => {
	it("按非字母数字切、转小写", () => {
		eq(tokenize("foo-bar_baz.qux"), ["foo", "bar", "baz", "qux"]);
	});
	it("拆 camelCase / PascalCase", () => {
		eq(tokenize("computeCacheHitRate"), ["compute", "cache", "hit", "rate"]);
	});
	it("拆连续大写 + 词（HTTPServer → http server）", () => {
		eq(tokenize("HTTPServer"), ["http", "server"]);
	});
	it("丢掉长度 <2 的碎片", () => {
		eq(tokenize("a bb c dd"), ["bb", "dd"]);
	});
});

describe("rag · chunkFile（切片带行号）", () => {
	it("长文件按行切成多个片段，行号正确", () => {
		const content = Array.from({ length: 95 }, (_, i) => `line ${i + 1}`).join("\n");
		const chunks = chunkFile("src/x.ts", content, 40);
		ok(chunks.length, 3); // 40 + 40 + 15
		ok(chunks[0].startLine, 1);
		ok(chunks[0].endLine, 40);
		ok(chunks[1].startLine, 41);
		ok(chunks[2].endLine, 95);
		ok(chunks[0].path, "src/x.ts");
	});
	it("跳过纯空白片段", () => {
		const content = "\n\n\n\n";
		eq(chunkFile("blank.ts", content, 2), []);
	});
});

describe("rag · scoreChunk（内容 +1，路径 +2）", () => {
	const chunk: CodeChunk = { path: "src/cost.ts", startLine: 1, endLine: 5, text: "function computeCacheHitRate() { return cacheRead; }" };
	it("内容命中得分", () => {
		// query "cache" 命中正文 (+1) 且命中路径吗？路径是 cost.ts 不含 cache → 只 +1
		ok(scoreChunk(chunk, tokenize("cache")) >= 1, true);
	});
	it("路径命中权重更高（query 含 cost → cost.ts 该被拉高）", () => {
		const sCost = scoreChunk(chunk, tokenize("cost"));
		ok(sCost >= 2, true); // 路径 cost 命中 +2
	});
	it("完全不相关得 0", () => {
		ok(scoreChunk(chunk, tokenize("kubernetes")), 0);
	});
	it("空 query 得 0", () => {
		ok(scoreChunk(chunk, []), 0);
	});
});

describe("rag · retrieveTopK（排序 + 边界）", () => {
	const index: CodeChunk[] = [
		{ path: "src/cost.ts", startLine: 1, endLine: 5, text: "cache hit rate compute" },
		{ path: "src/policy.ts", startLine: 1, endLine: 5, text: "dangerous command rm rf" },
		{ path: "src/readme.md", startLine: 1, endLine: 5, text: "hello world docs" },
	];
	it("相关的排前，无关的不进结果", () => {
		const hits = retrieveTopK(index, "cache cost", 8);
		truthy(hits.length >= 1, "有命中");
		ok(hits[0].chunk.path, "src/cost.ts"); // cost 路径+内容都命中，最高
		truthy(!hits.some((h) => h.chunk.path === "src/readme.md"), "无关的不进");
	});
	it("空 query → 空结果（不注入）", () => {
		eq(retrieveTopK(index, "", 8), []);
	});
	it("无命中 → 空结果", () => {
		eq(retrieveTopK(index, "kubernetes docker", 8), []);
	});
	it("k 限制生效", () => {
		const hits = retrieveTopK(index, "cache command docs hello", 1);
		ok(hits.length, 1);
	});
});

describe("rag · renderInjection（形状 + 字符上限）", () => {
	it("含文件路径+行号、标注是检索注入", () => {
		const hits = [{ chunk: { path: "src/cost.ts", startLine: 10, endLine: 20, text: "code here" } as CodeChunk, score: 3 }];
		const out = renderInjection(hits);
		truthy(out.includes("src/cost.ts:10-20"), "含路径行号");
		truthy(out.includes("EvoPi Codebase RAG"), "标注来源");
		truthy(out.includes("code here"), "含片段内容");
	});
	it("超字符上限时截断（不无限拼接）", () => {
		const big = "x".repeat(5000);
		const hits = Array.from({ length: 10 }, (_, i) => ({
			chunk: { path: `src/f${i}.ts`, startLine: 1, endLine: 40, text: big } as CodeChunk,
			score: 1,
		}));
		const out = renderInjection(hits);
		truthy(out.length < 6000 + 500, "受 INJECT_MAX_CHARS 约束，未全部拼入");
	});
});

describe("rag · lastUserText（取最后一条 user 文本做 query）", () => {
	it("字符串 content", () => {
		ok(lastUserText([{ role: "user", content: "改一下登录逻辑" }]), "改一下登录逻辑");
	});
	it("数组 content 取 text 部分", () => {
		ok(lastUserText([{ role: "user", content: [{ type: "text", text: "修 bug" }] }]), "修 bug");
	});
	it("取最后一条 user（跳过 assistant）", () => {
		ok(lastUserText([{ role: "user", content: "旧" }, { role: "assistant", content: "回复" }, { role: "user", content: "新" }]), "新");
	});
	it("无 user → 空串", () => {
		ok(lastUserText([{ role: "assistant", content: "hi" }]), "");
	});
});
