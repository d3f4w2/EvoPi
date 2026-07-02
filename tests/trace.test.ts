// tests/trace.test.ts — Trace 底座的纯工具函数：traceId 生成 + 内容摘要（隐私/体积裁剪）。
//
// Trace 是所有其它模块的底座。这里断言真实出货的 newTraceId / summarizeContent /
// summarizeMessage / formatCounts —— 关键属性：摘要**只记形状不记原文**（不把用户消息全文写进 JSONL）。

import { formatCounts, newTraceId, summarizeContent, summarizeMessage, safeJson } from "../.pi/extensions/evopi-trace/trace";
import { describe, it, eq, ok, truthy } from "./harness";

describe("trace · newTraceId", () => {
	it("形如 tr_<a>_<b>", () => {
		truthy(/^tr_[a-z0-9]+_[a-z0-9]+$/.test(newTraceId()), "格式");
	});
	it("多次生成不重复", () => {
		const ids = new Set(Array.from({ length: 50 }, () => newTraceId()));
		ok(ids.size, 50, "50 个各不相同");
	});
});

describe("trace · summarizeContent（只记形状，不记原文）", () => {
	it("统计 text/image/other 条目数与文本总长，不含原文", () => {
		const s = summarizeContent([
			{ type: "text", text: "hello world" }, // 11 字符
			{ type: "image", source: "..." },
			{ type: "tool_use", name: "bash" },
		]);
		eq(s, { items: 3, textItems: 1, imageItems: 1, otherItems: 1, totalTextLength: 11 });
		// 关键隐私属性：摘要里查不到原文
		truthy(!JSON.stringify(s).includes("hello world"), "不落原文");
	});
	it("非数组内容 → 只记 kind", () => {
		eq(summarizeContent("plain string"), { kind: "string" });
	});
});

describe("trace · summarizeMessage", () => {
	it("字符串 content 只记长度", () => {
		const s = summarizeMessage({ role: "user", type: "message", content: "some secret prompt text" });
		ok((s.content as { type: string; length: number }).type, "string");
		ok((s.content as { type: string; length: number }).length, "some secret prompt text".length);
		truthy(!JSON.stringify(s).includes("secret prompt"), "不落原文");
	});
	it("记录 role/type 与 toolCalls 数量", () => {
		const s = summarizeMessage({ role: "assistant", type: "message", content: [], toolCalls: [1, 2, 3] });
		ok(s.role, "assistant");
		ok(s.toolCalls, 3);
	});
	it("非对象 → 只记 kind", () => {
		eq(summarizeMessage(null), { kind: "object" });
	});
});

describe("trace · formatCounts / safeJson", () => {
	it("formatCounts 把计数表渲染成 'k: n' 行", () => {
		const lines = formatCounts({ "tool.call": 3, "cost.request": 1 });
		truthy(lines.some((l) => l.includes("tool.call") && l.includes("3")), "含 tool.call: 3");
	});
	it("safeJson 对不可序列化值兜底为占位符（不抛）", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		ok(safeJson(circular), "[unserializable]");
	});
	it("safeJson 对正常值原样返回", () => {
		eq(safeJson({ a: 1 }), { a: 1 });
	});
});
