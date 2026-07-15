/**
 * Session-level memory backend lifecycle helpers.
 *
 * Backends are mutually exclusive at runtime. Mid-session switches and
 * `/memory` maintenance paths share these helpers so dispose/start stays
 * atomic, listeners are never double-attached, and tools/prompt refresh from
 * one code path.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { setMnemopiSessionState } from "../mnemopi/state";
import type { AgentSession } from "../session/agent-session";
import { resolveMemoryBackend } from "./resolve";
import type { MemoryBackendId, MemoryBackendStartOptions } from "./types";

/** Built-in tools whose availability is gated by `memory.backend`. */
export const MEMORY_BACKEND_TOOL_NAMES = ["retain", "recall", "reflect", "memory_edit", "learn"] as const;

export type MemoryBackendToolName = (typeof MEMORY_BACKEND_TOOL_NAMES)[number];

export function isMemoryBackendToolName(name: string): name is MemoryBackendToolName {
	return (MEMORY_BACKEND_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Tear down whatever memory session state is currently live on `session`.
 *
 * Independent of the current `memory.backend` setting so a mid-session switch
 * can dispose the *old* backend after settings already point at the new one.
 */
export async function disposeLiveMemorySessionState(
	session: AgentSession,
	options: { consolidateMnemopi?: boolean } = {},
): Promise<void> {
	const consolidateMnemopi = options.consolidateMnemopi !== false;

	// Drop any in-flight local startup before tearing down other backends so a
	// prior local pipeline cannot refresh the prompt after ownership ends.
	session.cancelLocalMemoryStartup?.();

	const hindsightState = session.getHindsightSessionState?.();
	if (hindsightState) {
		try {
			await hindsightState.flushRetainQueue();
		} catch (error) {
			logger.warn("Memory lifecycle: hindsight flush before dispose failed", { error: String(error) });
		}
		session.setHindsightSessionState?.(undefined);
		try {
			hindsightState.dispose();
		} catch (error) {
			logger.warn("Memory lifecycle: hindsight dispose failed", { error: String(error) });
		}
	}

	const mnemopiState = setMnemopiSessionState(session, undefined);
	if (mnemopiState) {
		try {
			await mnemopiState.dispose({ consolidate: consolidateMnemopi });
		} catch (error) {
			logger.warn("Memory lifecycle: mnemopi dispose failed", { error: String(error) });
		}
	}
}

/**
 * Resolve, dispose any previous live state, and start the selected backend.
 * Failures during start are logged and swallowed so a misconfigured backend
 * cannot break the agent loop; the session is left without live state for that
 * backend (inert but coherent with the selection).
 */
export async function startResolvedMemoryBackend(options: MemoryBackendStartOptions): Promise<MemoryBackendId> {
	const backend = await resolveMemoryBackend(options.settings);
	// Dispose any previously live backend first so listeners/tools cannot route
	// to a displaced state while the new backend is still starting.
	await disposeLiveMemorySessionState(options.session, {
		// Preserve durable mnemopi banks when switching away; wipe paths pass
		// consolidate:false themselves before calling removeDbFiles.
		consolidateMnemopi: true,
	});
	if (options.session.isDisposed) return backend.id;
	try {
		await backend.start(options);
	} catch (error) {
		logger.warn("Memory lifecycle: backend start failed; memory backend inert.", {
			backend: backend.id,
			error: String(error),
		});
	}
	// Start may have installed state after dispose began (race). Tear it down.
	if (options.session.isDisposed) {
		await disposeLiveMemorySessionState(options.session, { consolidateMnemopi: false });
	}
	return backend.id;
}
