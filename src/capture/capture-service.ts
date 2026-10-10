import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { continuityHome } from "../cli/config.js";
import { findExecutable } from "../cli/connectors.js";

export const CAPTURE_SERVICE_LABEL = "com.opencontinuity.capture";
export interface CaptureServiceConfig { intervalMs: number; pageSize: number; maxThreads: number; retryLimit: number; }
export interface CaptureServicePaths { plistPath: string; stdoutPath: string; stderrPath: string; }
const defaultServiceConfig: CaptureServiceConfig = { intervalMs: 5000, pageSize: 20, maxThreads: 100, retryLimit: 3 };
const defaultLaunchdPath = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export function captureServiceSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  return findExecutable(["launchctl"], { ...env, PATH: env.PATH || defaultLaunchdPath }) !== null;
}

export function captureServicePaths(env: NodeJS.ProcessEnv = process.env): CaptureServicePaths {
  const home = continuityHome(env);
  return { plistPath: join(env.HOME || homedir(), "Library", "LaunchAgents", CAPTURE_SERVICE_LABEL + ".plist"), stdoutPath: join(home, "capture-service.log"), stderrPath: join(home, "capture-service.error.log") };
}

export function captureServiceDomain(env: NodeJS.ProcessEnv = process.env): string {
  return "gui/" + Number(env.UID || process.getuid?.() || 0);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function captureServiceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const binary = findExecutable(["traecli", "traex"], env);
  const binaryDirectory = binary ? dirname(binary) : undefined;
  const pathEntries = [...new Set([binaryDirectory, ...defaultLaunchdPath.split(":"), ""])].filter(Boolean);
  const environment: Record<string, string> = { HOME: env.HOME || homedir(), PATH: pathEntries.join(":") };
  for (const key of ["OPEN_CONTINUITY_HOME", "TRAECLI_HOME", "TRAE_HOME"]) {
    const value = env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

export function renderCaptureServicePlist(input: { nodePath: string; cliPath: string; config?: Partial<CaptureServiceConfig>; paths?: CaptureServicePaths; environment?: Record<string, string> }): string {
  const config = { ...defaultServiceConfig, ...input.config };
  const paths = input.paths || captureServicePaths();
  const args = [input.nodePath, input.cliPath, "capture", "watch", "--interval", String(config.intervalMs), "--limit", String(config.pageSize), "--max-threads", String(config.maxThreads), "--retry-limit", String(config.retryLimit)];
  const argumentsXml = args.map((arg) => "    <string>" + xml(arg) + "</string>").join("\n");
  const environmentXml = Object.entries(input.environment || {}).map(([key, value]) => "    <key>" + xml(key) + "</key><string>" + xml(value) + "</string>").join("\n");
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
    "<plist version=\"1.0\">\n<dict>\n" +
    "  <key>Label</key><string>" + CAPTURE_SERVICE_LABEL + "</string>\n" +
    "  <key>ProgramArguments</key><array>\n" + argumentsXml + "\n  </array>\n" +
    "  <key>EnvironmentVariables</key><dict>\n" + environmentXml + "\n  </dict>\n" +
    "  <key>WorkingDirectory</key><string>" + xml(dirname(input.cliPath)) + "</string>\n" +
    "  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n" +
    "  <key>ThrottleInterval</key><integer>10</integer>\n  <key>ProcessType</key><string>Background</string>\n" +
    "  <key>StandardOutPath</key><string>" + xml(paths.stdoutPath) + "</string>\n" +
    "  <key>StandardErrorPath</key><string>" + xml(paths.stderrPath) + "</string>\n" +
    "</dict>\n</plist>\n";
}

export interface CaptureServiceRuntime {
  launchctl?: (args: string[], env: NodeJS.ProcessEnv) => { ok: boolean; output: string };
  wait?: (milliseconds: number) => void;
}

function launchctl(args: string[], env: NodeJS.ProcessEnv, runtime: CaptureServiceRuntime = {}): { ok: boolean; output: string } {
  if (runtime.launchctl) return runtime.launchctl(args, env);
  const result = spawnSync("launchctl", args, { env, encoding: "utf8" });
  return { ok: result.status === 0, output: [result.stdout, result.stderr].filter(Boolean).join("").trim() };
}

function wait(milliseconds: number, runtime: CaptureServiceRuntime): void {
  if (runtime.wait) { runtime.wait(milliseconds); return; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function serviceTarget(domain: string): string { return domain + "/" + CAPTURE_SERVICE_LABEL; }

function serviceMatchesPlist(output: string, plistPath: string): boolean {
  const registeredPath = output.match(/^\s*path = (.+)$/mu)?.[1]?.trim().replace(/^"|"$/gu, "");
  // Older/fake launchctl implementations do not expose the registered path.
  // In that case retain the label-based behavior for compatibility.
  return !registeredPath || resolve(registeredPath) === resolve(plistPath);
}

export function installCaptureService(input: { nodePath: string; cliPath: string; config?: Partial<CaptureServiceConfig> }, env: NodeJS.ProcessEnv = process.env) {
  const paths = captureServicePaths(env);
  mkdirSync(dirname(paths.plistPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 });
  const plist = renderCaptureServicePlist({ ...input, paths, environment: captureServiceEnvironment(env) });
  const changed = !existsSync(paths.plistPath) || readFileSync(paths.plistPath, "utf8") !== plist;
  if (changed) writeFileSync(paths.plistPath, plist, { encoding: "utf8", mode: 0o600 });
  return { label: CAPTURE_SERVICE_LABEL, paths, installed: true, changed, config: { ...defaultServiceConfig, ...input.config } };
}

export function startCaptureService(env: NodeJS.ProcessEnv = process.env, runtime: CaptureServiceRuntime = {}) {
  const paths = captureServicePaths(env);
  if (!existsSync(paths.plistPath)) throw new Error("Capture service is not installed");
  const domain = captureServiceDomain(env);
  const target = serviceTarget(domain);
  const existing = launchctl(["print", target], env, runtime);
  if (existing.ok && !serviceMatchesPlist(existing.output, paths.plistPath)) {
    throw new Error("Capture service label is already loaded from a different plist");
  }
  if (existing.ok) {
    return { label: CAPTURE_SERVICE_LABEL, status: "running", domain, plistPath: paths.plistPath, alreadyRunning: true };
  }
  const loaded = launchctl(["bootstrap", domain, paths.plistPath], env, runtime);
  const running = launchctl(["print", target], env, runtime);
  if (!running.ok) {
    throw new Error(loaded.output || "Unable to start capture service");
  }
  return { label: CAPTURE_SERVICE_LABEL, status: "running", domain, plistPath: paths.plistPath, alreadyRunning: false };
}

export function stopCaptureService(env: NodeJS.ProcessEnv = process.env, runtime: CaptureServiceRuntime = {}) {
  const domain = captureServiceDomain(env);
  const target = serviceTarget(domain);
  const status = launchctl(["print", target], env, runtime);
  if (!status.ok) return { label: CAPTURE_SERVICE_LABEL, status: "stopped", domain, existed: false };
  const paths = captureServicePaths(env);
  if (!serviceMatchesPlist(status.output, paths.plistPath)) {
    return { label: CAPTURE_SERVICE_LABEL, status: "stopped", domain, existed: false, differentInstanceRunning: true };
  }
  const result = launchctl(["bootout", target], env, runtime);
  let remaining = launchctl(["print", target], env, runtime);
  for (let attempt = 0; remaining.ok && attempt < 5; attempt += 1) {
    wait(50, runtime);
    remaining = launchctl(["print", target], env, runtime);
  }
  if (remaining.ok) throw new Error(result.ok ? "Capture service is still running after bootout" : result.output || "Unable to stop capture service");
  return { label: CAPTURE_SERVICE_LABEL, status: "stopped", domain, existed: true, ...(result.ok ? {} : { warning: result.output || "launchctl reported an error after the service stopped" }) };
}

export function statusCaptureService(env: NodeJS.ProcessEnv = process.env, runtime: CaptureServiceRuntime = {}) {
  const paths = captureServicePaths(env);
  const domain = captureServiceDomain(env);
  const result = launchctl(["print", serviceTarget(domain)], env, runtime);
  const installed = existsSync(paths.plistPath);
  const matchingService = result.ok && serviceMatchesPlist(result.output, paths.plistPath);
  return {
    label: CAPTURE_SERVICE_LABEL, domain, installed, running: installed && matchingService, plistPath: paths.plistPath,
    ...(result.ok && !matchingService ? { differentInstanceRunning: true } : {}), output: result.output || undefined,
  };
}

export function uninstallCaptureService(env: NodeJS.ProcessEnv = process.env, runtime: CaptureServiceRuntime = {}) {
  const stopped = stopCaptureService(env, runtime);
  const paths = captureServicePaths(env);
  if (existsSync(paths.plistPath)) unlinkSync(paths.plistPath);
  return { ...stopped, status: "uninstalled", installed: false, plistPath: paths.plistPath };
}
