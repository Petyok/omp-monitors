// Integration tests: real bash children and the extension's real batching timers, so fake timers cannot
// drive them; every wait below waits for an observable condition, never for a guessed duration.
import { afterEach, expect, test } from "bun:test";
import monitors from "../src/index.ts";

type Result = { content: { text: string }[]; isError?: boolean };
type Tool = { name: string; execute(id: string, params: object): Promise<Result> };
type Command = { handler(args: string, ctx: object): Promise<void> };

// pi.zod stand-in: every schema call chains, the tests call execute directly.
const anySchema: unknown = new Proxy(() => anySchema, { get: () => anySchema, apply: () => anySchema });

function load() {
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const handlers = new Map<string, () => void>();
	const messages: string[] = [];
	monitors({
		zod: anySchema,
		registerTool: (t: Tool) => tools.set(t.name, t),
		registerCommand: (name: string, c: Command) => commands.set(name, c),
		on: (event: string, fn: () => void) => handlers.set(event, fn),
		sendMessage: (m: { content: string }) => messages.push(m.content),
	} as never);
	const call = (name: string, params: object) => tools.get(name)!.execute("id", params);
	/** What `/monitors` would show. */
	const list = async () => {
		let shown = "";
		await commands.get("monitors")!.handler("", { ui: { notify: (text: string) => (shown = text) } });
		return shown;
	};
	return { call, list, messages, shutdown: () => handlers.get("session_shutdown")?.() };
}

async function until(check: () => boolean | Promise<boolean>, ms = 3_000) {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(10);
	}
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

let shutdown: (() => void) | undefined;
afterEach(() => shutdown?.());

test("lines are batched by quiet time; the exit message carries its code and the last lines", async () => {
	const s = load();
	shutdown = s.shutdown;
	await s.call("monitor", {
		name: "t", description: "test", quietMs: 150, minIntervalMs: 0,
		command: "echo a; echo b >&2; sleep 0.5; echo c; exit 3",
	});
	await until(() => s.messages.length === 2);
	expect(s.messages).toEqual([
		'Monitor "t" (test) printed:\na\nb',
		'Monitor "t" (test) exited with code 3.\nc',
	]);
});

test("monitor_stop kills the process group, drops undelivered output and sends nothing afterwards", async () => {
	const s = load();
	shutdown = s.shutdown;
	const started = await s.call("monitor", {
		name: "t", description: "test", quietMs: 60_000, command: "echo pending; sleep 30 & wait",
	});
	const pid = Number(/pid (\d+)/.exec(started.content[0].text)![1]);
	await until(async () => (await s.list()).includes("1 lines")); // read, held back by the long quiet time
	const r = await s.call("monitor_stop", { name: "t" });
	expect(r.content[0].text).toContain('Monitor "t" stopped after');
	await until(() => !alive(pid) && !alive(-pid)); // bash and its background sleep are gone
	expect(s.messages).toEqual([]);
	expect((await s.call("monitor_stop", { name: "t" })).isError).toBe(true);
});

test("a running name cannot be started twice; a finished one can", async () => {
	const s = load();
	shutdown = s.shutdown;
	await s.call("monitor", { name: "t", description: "test", command: "sleep 30" });
	expect((await s.call("monitor", { name: "t", description: "test", command: "true" })).isError).toBe(true);
	await s.call("monitor_stop", { name: "t" });
	expect((await s.call("monitor", { name: "t", description: "test", command: "true" })).isError).toBeUndefined();
});

test("a huge batch keeps the newest output and says how much was dropped", async () => {
	const s = load();
	shutdown = s.shutdown;
	await s.call("monitor", {
		name: "t", description: "test", quietMs: 100, minIntervalMs: 0,
		command: "for i in $(seq 1 2000); do echo line-$i; done; sleep 30",
	});
	await until(() => s.messages.length === 1);
	const body = s.messages[0];
	expect(body).toMatch(/\[… \d+ chars of earlier output dropped\]/);
	expect(body.endsWith("line-2000")).toBe(true);
	expect(body).not.toContain("line-1\n");
	expect(body.length).toBeLessThan(6_200);
});
