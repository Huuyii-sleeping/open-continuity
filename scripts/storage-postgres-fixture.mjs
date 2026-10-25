import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Opt-in engineering fixture only; no default runtime dependency or user database.
const execute = promisify(execFile);
const docker = process.env.OPEN_CONTINUITY_TEST_DOCKER_BIN || "docker";
const root = fileURLToPath(new URL("../", import.meta.url));
const identity = randomUUID();
const name = `open-continuity-storage-${identity}`;
const label = `open-continuity.fixture=${identity}`;
let context;
let attempted = false;
let interrupted = false;
let child;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  child?.kill("SIGTERM");
});

async function command(args, timeout = 30000) {
  const result = await execute(docker, [...(context ? ["--context", context] : []), ...args], { timeout, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

try {
  context = await command(["context", "show"]);
  const endpoint = await command(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]);
  if (!/^(unix:\/\/|npipe:\/\/)/.test(endpoint)) throw new Error("A local Docker context is required");
  const password = randomBytes(24).toString("hex");
  attempted = true;
  await command(["run", "--detach", "--rm", "--name", name, "--label", label,
    "--memory=512m", "--cpus=2", "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,size=256m",
    "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=fictional_test",
    "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=open_continuity_test",
    "postgres:17-alpine"], 60000);
  let ready = false;
  const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline && !interrupted) {
    // The image's temporary init server accepts Unix sockets, but not TCP.
    try { await command(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "fictional_test", "-d", "open_continuity_test"], 2000); ready = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!ready || interrupted) throw new Error("Fixture did not become ready");
  const address = await command(["port", name, "5432/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Fixture must bind only loopback");
  const version = await command(["exec", name, "psql", "-U", "fictional_test", "-d", "open_continuity_test", "-Atc", "SHOW server_version"]);
  const image = await command(["inspect", name, "--format", "{{.Image}}"]);
  process.stdout.write(JSON.stringify({ fixture: "disposable real PostgreSQL", version, image, storage: "tmpfs", binding: "loopback only" }) + "\n");
  const code = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "test/storage-postgres-real.test.ts", ...process.argv.slice(2)], {
      cwd: root, stdio: "inherit",
      env: { ...process.env, OPEN_CONTINUITY_TEST_POSTGRES_URL: `postgresql://fictional_test:${password}@${address}/open_continuity_test` },
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
    if (interrupted) child.kill("SIGTERM");
  });
  process.exitCode = interrupted ? 1 : code;
} catch {
  // Do not expose Docker configuration, connection strings or driver details.
  process.stderr.write("Disposable PostgreSQL verification failed; check local Docker availability and test output.\n");
  process.exitCode = 1;
} finally {
  if (attempted) {
    try {
      const owner = await command(["inspect", name, "--format", '{{index .Config.Labels "open-continuity.fixture"}}']);
      if (owner !== identity) throw new Error("Fixture ownership mismatch");
      await command(["stop", "--timeout", "5", name]);
      process.stdout.write("Fixture stopped; disposable tmpfs database removed.\n");
    } catch {
      process.stderr.write("Fixture cleanup could not be confirmed; inspect only the task fixture listed below.\n");
      process.stderr.write(name + "\n");
      process.exitCode = 1;
    }
  }
}
