/**
 * Monitors for omp: Claude Code's "Monitor" tool.
 *
 * `monitor` starts a long-running command in the background and returns at once. Every batch of
 * lines it prints (stdout and stderr) is delivered to the session as a message that starts a turn
 * when the agent is idle and queues behind the current run when it is busy, so a watcher script
 * only has to print a line per event and keep running; the agent never polls and never re-arms.
 * When the command exits that is delivered too (with its exit code), so a dead monitor is never
 * silent.
 *
 * Lines are batched: a delivery goes out once the output has been quiet for `quietMs` (default 2 s)
 * and at most once per `minIntervalMs` (default 10 s); one delivery carries at most MAX_CHARS
 * (the tail is kept, the head dropped is counted). `monitor_stop` and `/monitors` stop and list.
 * Running monitors are listed below the editor, one row each:
 *
 *   ◉ ci-logs 25m12s · 3 wakes  failed jobs of the release pipeline
 *
 * Everything a session started is killed with its process group on session shutdown.
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as readline from "node:readline";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, TUI } from "@oh-my-pi/pi-tui";

const MESSAGE_TYPE = "monitor";
const MAX_CHARS = 6_000;
const WIDGET_KEY = "monitors";
const MAX_ROWS = 5;
/** Elapsed times show seconds; the TUI only redraws on its own while a turn streams. */
const TICK_MS = 1_000;

interface MonitorParams {
	name: string;
	command: string;
	description: string;
	quietMs?: number;
	minIntervalMs?: number;
}

interface StopParams {
	name: string;
}

interface Monitor {
	name: string;
	command: string;
	description: string;
	child: ChildProcess;
	started: number;
	lines: number;
	deliveries: number;
	pending: string[];
	lastDelivery: number;
	timer?: NodeJS.Timeout;
	quietMs: number;
	minIntervalMs: number;
	exited?: string;
}

/** The subset of omp's `Theme` the footer uses. */
interface FooterTheme {
	fg(color: "statusLineSubagents" | "muted" | "dim", text: string): string;
}

function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Cuts plain text to `width` terminal cells, ending in "…" when cut. */
function fit(text: string, width: number): string {
	if (Bun.stringWidth(text) <= width) return text;
	if (width < 1) return "";
	let out = "";
	let used = 0;
	for (const ch of text) {
		const w = Bun.stringWidth(ch);
		if (used + w > width - 1) break;
		out += ch;
		used += w;
	}
	return `${out}…`;
}

class MonitorsList implements Component {
	constructor(
		private readonly live: () => Monitor[],
		private readonly theme: FooterTheme,
	) {}

	render(width: number): string[] {
		const live = this.live();
		const now = Date.now();
		const shown = live.length > MAX_ROWS ? live.slice(0, MAX_ROWS - 1) : live;
		const lines = shown.map(m => this.#row(m, width, now));
		if (shown.length < live.length) {
			lines.push(this.theme.fg("muted", fit(`  +${live.length - shown.length} more · /monitors`, width)));
		}
		return lines;
	}

	#row(m: Monitor, width: number, now: number): string {
		const t = this.theme;
		const tag = `◉ ${m.name}`;
		const meta = `${elapsed(now - m.started)} · ${m.deliveries} wake${m.deliveries === 1 ? "" : "s"}`;
		const room = width - Bun.stringWidth(`${tag} ${meta}  `);
		// Too narrow for a useful description: keep the identifying part only.
		if (room < 4) return t.fg("muted", fit(`${tag} ${meta}`, width));
		return `${t.fg("statusLineSubagents", tag)} ${t.fg("muted", meta)}  ${t.fg("dim", fit(m.description, room))}`;
	}

	invalidate(): void {}
}

export default function monitors(pi: ExtensionAPI): void {
	const z = pi.zod;
	// per session: child sessions rebind this factory and get their own set
	const running = new Map<string, Monitor>();
	const live = (): Monitor[] => [...running.values()].filter(m => !m.exited);
	let tui: TUI | undefined;
	let lastCount = 0;
	let tickStarted = false;

	function mount(ctx: ExtensionContext): void {
		// Component widgets exist only in the TUI.
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(ui, theme) => {
				tui = ui;
				return new MonitorsList(live, theme);
			},
			{ placement: "belowEditor" },
		);
		if (tickStarted) return;
		tickStarted = true;
		// Redraw while monitors run (elapsed time, a new or exited row), plus once more to clear the last row.
		ctx.setInterval(() => {
			const count = live().length;
			if (count > 0 || lastCount > 0) tui?.requestRender();
			lastCount = count;
		}, TICK_MS);
	}

	pi.on("session_start", (_event, ctx) => mount(ctx));
	// Session switches clear hook widgets.
	pi.on("session_switch", (_event, ctx) => mount(ctx));

	function deliver(m: Monitor, final: boolean): void {
		clearTimeout(m.timer);
		m.timer = undefined;
		if (!m.pending.length && !final) return;
		let body = m.pending.join("\n");
		if (body.length > MAX_CHARS) {
			// keep the newest output, cut at a line start
			const tail = body.slice(body.length - MAX_CHARS);
			body = `[… ${body.length - MAX_CHARS} chars of earlier output dropped]\n${tail.slice(tail.indexOf("\n") + 1)}`;
		}
		m.pending = [];
		m.lastDelivery = Date.now();
		m.deliveries++;
		const head = final
			? `Monitor "${m.name}" (${m.description}) ${m.exited}.`
			: `Monitor "${m.name}" (${m.description}) printed:`;
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: body ? `${head}\n${body}` : head, display: true },
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	function schedule(m: Monitor): void {
		clearTimeout(m.timer);
		const sinceLast = Date.now() - m.lastDelivery;
		const wait = Math.max(m.quietMs, m.minIntervalMs - sinceLast);
		m.timer = setTimeout(() => {
			try {
				deliver(m, false);
			} catch {
				// a failed delivery must not take the session down; the next line retries
			}
		}, wait);
		m.timer.unref?.();
	}

	function stop(m: Monitor): void {
		if (m.child.exitCode === null && m.child.pid) {
			try {
				process.kill(-m.child.pid, "SIGTERM");
			} catch {
				m.child.kill("SIGTERM");
			}
		}
	}

	pi.registerTool({
		name: "monitor",
		label: "Monitor",
		description:
			"Start a long-running command in the background that wakes the agent with every batch of lines it prints " +
			"(and once more when it exits). Use for watchers: a script that prints one line per event (new alert, log " +
			"match, state change) and keeps running. Returns immediately; output arrives as messages that start a turn " +
			"when idle or queue behind the current run. Stop with monitor_stop; list with /monitors.",
		parameters: z.object({
			name: z.string().describe("Unique short name, e.g. ci-logs"),
			command: z.string().describe("bash command; print one line per event, flush stdout (python -u)"),
			description: z.string().describe("What it watches, shown in every delivery"),
			quietMs: z.number().optional().describe("Deliver after the output was quiet this long (default 2000)"),
			minIntervalMs: z.number().optional().describe("At most one delivery per this interval (default 10000)"),
		}),
		async execute(_id, params) {
			// the schema above validated the arguments before execute runs
			const p = params as MonitorParams;
			const { name, command, description } = p;
			const old = running.get(name);
			if (old && !old.exited) {
				return { content: [{ type: "text", text: `Monitor "${name}" is already running (pid ${old.child.pid}); stop it first.` }], isError: true };
			}
			const child = spawn("bash", ["-c", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
			const m: Monitor = {
				name, command, description, child, started: Date.now(), lines: 0, deliveries: 0, pending: [],
				lastDelivery: 0,
				quietMs: p.quietMs ?? 2_000,
				minIntervalMs: p.minIntervalMs ?? 10_000,
			};
			running.set(name, m);
			for (const stream of [child.stdout, child.stderr]) {
				if (!stream) continue;
				readline.createInterface({ input: stream }).on("line", line => {
					if (m.exited) return; // stopped: lines printed while dying are not news
					m.lines++;
					m.pending.push(line);
					schedule(m);
				});
			}
			child.on("error", err => {
				m.exited = `failed to start: ${err.message}`;
				deliver(m, true);
			});
			child.on("close", (code, signal) => {
				if (m.exited) return;
				m.exited = signal ? `was stopped (${signal})` : `exited with code ${code}`;
				deliver(m, true);
			});
			return {
				content: [{ type: "text", text: `Monitor "${name}" started (pid ${child.pid}): ${description}. Its output will arrive as messages; end the turn when nothing else is left.` }],
				details: { name, pid: child.pid },
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "Stop monitor",
		description: "Stop a monitor started with the monitor tool (kills its process group).",
		parameters: z.object({ name: z.string().describe("Monitor name") }),
		async execute(_id, params) {
			// the schema above validated the arguments before execute runs
			const { name } = params as StopParams;
			const m = running.get(name);
			if (!m || m.exited) {
				return { content: [{ type: "text", text: `No running monitor named "${name}".` }], isError: true };
			}
			m.exited = "was stopped by monitor_stop"; // set first: the close event then delivers nothing
			// output read but not yet delivered belongs to the stopped run: drop it
			clearTimeout(m.timer);
			m.pending = [];
			stop(m);
			return { content: [{ type: "text", text: `Monitor "${m.name}" stopped after ${elapsed(Date.now() - m.started)}, ${m.lines} lines.` }] };
		},
	});

	pi.registerCommand("monitors", {
		description: "List monitors (running and finished) of this session",
		handler: async (_args, ctx) => {
			if (!running.size) return ctx.ui.notify("No monitors in this session.", "info");
			const rows = [...running.values()].map(
				m => `${m.exited ? "■" : "●"} ${m.name}  ${m.exited ?? `pid ${m.child.pid}`}  up ${elapsed(Date.now() - m.started)}  ` +
					`${m.lines} lines / ${m.deliveries} wakes  — ${m.description}`,
			);
			ctx.ui.notify(rows.join("\n"), "info");
		},
	});

	pi.on("session_shutdown", () => {
		tickStarted = false;
		for (const m of running.values()) {
			clearTimeout(m.timer);
			m.exited ??= "was stopped at session shutdown"; // no delivery into a closing session
			stop(m);
		}
	});
}
