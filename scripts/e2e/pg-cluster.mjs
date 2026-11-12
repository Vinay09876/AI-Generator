// Throwaway PostgreSQL cluster for isolated tests (never the installed service).
//   node pg-cluster.mjs init|start|stop|destroy <dataDir>
// Port 55432, listens on 127.0.0.1 only, trust auth for loopback only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [cmd, dataDirArg] = process.argv.slice(2);
const BIN = process.env.PG_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin";
const dataDir = path.resolve(dataDirArg ?? "");
const PORT = "55432";
const run = (exe, args) => execFileSync(path.join(BIN, exe), args, { stdio: "inherit" });

if (!dataDirArg || !/scratchpad|e2e/i.test(dataDir)) {
  console.error("refusing: data directory must be inside the scratchpad e2e folder");
  process.exit(2);
}

switch (cmd) {
  case "init":
    if (fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
      console.log("[pg] already initialised");
      break;
    }
    run("initdb.exe", ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"]);
    // Loopback only; no other hosts may connect.
    fs.writeFileSync(path.join(dataDir, "pg_hba.conf"), "host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n");
    fs.appendFileSync(path.join(dataDir, "postgresql.conf"), `\nport = ${PORT}\nlisten_addresses = '127.0.0.1'\nmax_connections = 60\nfsync = off\n`);
    break;
  case "start":
    // stdio "ignore": on Windows the postmaster would otherwise inherit our pipes and keep this
    // process waiting forever.
    execFileSync(path.join(BIN, "pg_ctl.exe"), ["-D", dataDir, "-l", path.join(dataDir, "server.log"), "-w", "start"], { stdio: "ignore" });
    for (const db of ["yourai_e2e", "yourai_it"]) {
      try {
        execFileSync(path.join(BIN, "psql.exe"), ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-tAc", `select 1 from pg_database where datname='${db}'`], { encoding: "utf8" }).trim() === "1" ||
          run("psql.exe", ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-c", `create database ${db}`]);
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
    }
    break;
  case "stop":
    run("pg_ctl.exe", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
    break;
  case "destroy":
    try {
      run("pg_ctl.exe", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
    } catch {
      // not running
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    break;
  default:
    console.error("usage: pg-cluster.mjs init|start|stop|destroy <dataDir>");
    process.exit(2);
}
