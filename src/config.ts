import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";
import { isReasoningEffort, type ReasoningEffort } from './reasoning.js';

export interface Config {
  workingDirectory: string;
  model?: string;
  serviceTier?: "default" | "fast";
  autoRouting?: boolean;
  reasoningEffort?: ReasoningEffort;
  mode?: "plan" | "workspace" | "danger";
}

const CONFIG_DIR = DATA_DIR;
const CONFIG_PATH = join(CONFIG_DIR, "config.env");

const DEFAULT_CONFIG: Config = {
  workingDirectory: process.cwd(),
  mode: "workspace",
  reasoningEffort: "medium",
};

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function parseConfigFile(content: string): Config {
  const config: Config = { ...DEFAULT_CONFIG };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    switch (key) {
      case "workingDirectory":
        config.workingDirectory = value;
        break;
      case "model":
        config.model = value;
        break;
      case "serviceTier":
        if (value === "default" || value === "fast") config.serviceTier = value;
        break;
      case "autoRouting":
        config.autoRouting = value === 'true';
        break;
      case "reasoningEffort":
        if (isReasoningEffort(value)) config.reasoningEffort = value;
        break;
      case "mode":
        if (value === "plan" || value === "workspace" || value === "danger") {
          config.mode = value;
        }
        break;
    }
  }
  return config;
}

export function loadConfig(): Config {
  try {
    const content = readFileSync(CONFIG_PATH, "utf-8");
    return parseConfigFile(content);
  } catch {
    // File does not exist yet — return defaults
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  const lines: string[] = [];
  lines.push(`workingDirectory=${config.workingDirectory}`);
  if (config.model) {
    lines.push(`model=${config.model}`);
  }
  if (config.serviceTier) lines.push(`serviceTier=${config.serviceTier}`);
  if (config.autoRouting !== undefined) lines.push(`autoRouting=${config.autoRouting}`);
  lines.push(`reasoningEffort=${config.reasoningEffort ?? 'medium'}`);
  if (config.mode) {
    lines.push(`mode=${config.mode}`);
  }
  writeFileSync(CONFIG_PATH, lines.join("\n") + "\n", "utf-8");
  if (process.platform !== 'win32') {
    chmodSync(CONFIG_PATH, 0o600);
  }
}
