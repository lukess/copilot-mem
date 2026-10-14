import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Settings kept in $COPILOT_MEM_DATA_DIR/settings.json (like claude-mem's settings.json). An
 * environment variable of the same name wins over the file; an empty value means the default.
 */
export const SETTING_DEFAULTS = {
  /** Copilot session store; '' = $COPILOT_HOME/session-store.db. */
  COPILOT_MEM_SOURCE_DB: '',
  // gpt-5-mini costs 0 premium requests on Copilot plans (verified with --usage-output-file).
  COPILOT_MEM_MODEL: 'gpt-5-mini',
  COPILOT_MEM_AUTO_COMPRESS: '5',
  /** '' = copilot on PATH; install records the one it found. */
  COPILOT_MEM_COPILOT_BIN: '',
  /**
   * local (in-process ONNX model; `copilot-mem embed --setup` installs it) | ollama | openai (any
   * OpenAI-compatible endpoint) | voyage | cohere | jina | off.
   */
  COPILOT_MEM_EMBED_PROVIDER: 'local',
  /**
   * '' = the provider's default model; 'off' also disables semantic search. Local models:
   * Xenova/bge-small-en-v1.5 (default; English, ~33 MB), Xenova/all-MiniLM-L6-v2 (English, ~23 MB,
   * fastest), Xenova/multilingual-e5-small (~100 languages, ~145 MB), Xenova/bge-m3 (~100 languages,
   * ~570 MB; ollama's default model, run in-process).
   */
  COPILOT_MEM_EMBED_MODEL: '',
  /** '' = the provider's default endpoint (for local: the Hugging Face host models download from). */
  COPILOT_MEM_EMBED_URL: '',
  /** API key for cloud providers (not needed for local or ollama). */
  COPILOT_MEM_EMBED_API_KEY: '',
};

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type Settings = (key: SettingKey) => string;
export const SECRET_SETTINGS: ReadonlySet<SettingKey> = new Set(['COPILOT_MEM_EMBED_API_KEY']);
/** Older environment variables still honoured. */
const LEGACY: Partial<Record<SettingKey, string>> = { COPILOT_MEM_EMBED_URL: 'COPILOT_MEM_OLLAMA_URL' };

export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_MEM_DATA_DIR || join(homedir(), '.copilot-mem');
}

export function settingsPath(dir = dataDir()): string {
  return join(dir, 'settings.json');
}

/** The settings file's string values; {} when it doesn't exist. */
export function readSettingsFile(path = settingsPath()): Partial<Record<SettingKey, string>> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object`);
  const values: Partial<Record<SettingKey, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key in SETTING_DEFAULTS && value !== null && value !== undefined) values[key as SettingKey] = String(value);
  }
  return values;
}

export type SettingSource = 'env' | 'file' | 'default';

/** A setting's effective value and where it came from: environment, then settings file, then default. */
export function resolveSetting(
  key: SettingKey,
  env: NodeJS.ProcessEnv,
  file: Partial<Record<SettingKey, string>>,
): { value: string; source: SettingSource } {
  const fromEnv = env[key] || (LEGACY[key] ? env[LEGACY[key]] : undefined);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  if (file[key]) return { value: file[key], source: 'file' };
  return { value: SETTING_DEFAULTS[key], source: 'default' };
}

/** Settings for this process (environment over $COPILOT_MEM_DATA_DIR/settings.json). */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, path = settingsPath(dataDir(env))): Settings {
  const file = readSettingsFile(path);
  return (key) => resolveSetting(key, env, file).value;
}

/**
 * Creates the settings file with every key if it is missing (owner-only: it can hold an API key),
 * and copies in values set in `env`, so settings exported before install keep working once install
 * stops forwarding them. Returns the keys it wrote from `env`.
 */
export function saveSettingsFile(path: string, env: NodeJS.ProcessEnv, extra: Partial<Record<SettingKey, string>> = {}): {
  created: boolean;
  fromEnv: SettingKey[];
} {
  const created = !existsSync(path);
  const current: Record<string, unknown> = created ? { ...SETTING_DEFAULTS } : JSON.parse(readFileSync(path, 'utf8'));
  const fromEnv: SettingKey[] = [];
  for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
    if (!(key in current)) current[key] = SETTING_DEFAULTS[key];
    const value = env[key] || (LEGACY[key] ? env[LEGACY[key]] : undefined);
    if (value && current[key] !== value) {
      current[key] = value;
      fromEnv.push(key);
    }
  }
  Object.assign(current, extra);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { created, fromEnv };
}

/** Every setting's effective value and source; secrets are masked. */
export function describeSettings(env: NodeJS.ProcessEnv = process.env, path = settingsPath(dataDir(env))) {
  const file = readSettingsFile(path);
  return {
    path,
    exists: existsSync(path),
    settings: Object.fromEntries(
      (Object.keys(SETTING_DEFAULTS) as SettingKey[]).map((key) => {
        const { value, source } = resolveSetting(key, env, file);
        return [key, { value: SECRET_SETTINGS.has(key) && value ? `${value.slice(0, 4)}...(${value.length} chars)` : value, source }];
      }),
    ),
  };
}

export function sourceDbPath(settings = loadSettings()): string {
  return settings('COPILOT_MEM_SOURCE_DB') || join(copilotHome(), 'session-store.db');
}

/** Per-session event logs (events.jsonl) live next to the session store. */
export function sessionStateDir(settings = loadSettings()): string {
  return join(dirname(sourceDbPath(settings)), 'session-state');
}

export function memoryDbPath(): string {
  return join(dataDir(), 'memory.db');
}

export function compressorModel(settings = loadSettings()): string {
  return settings('COPILOT_MEM_MODEL');
}

export function copilotBin(settings = loadSettings()): string {
  return settings('COPILOT_MEM_COPILOT_BIN') || 'copilot';
}

/** Max Copilot calls each background worker run may spend on compression; 0 turns it off. */
export function autoCompressLimit(settings = loadSettings()): number {
  const limit = Number(settings('COPILOT_MEM_AUTO_COMPRESS'));
  if (!Number.isInteger(limit) || limit < 0) throw new Error('COPILOT_MEM_AUTO_COMPRESS must be a non-negative integer');
  return limit;
}
