import { startBridge } from "./app.js";
import { resolveDataDir } from "./dataDir.js";

const USAGE = "usage: node dist/daemon.js --port <0-65535>";

function parsePort(argv: string[]): number | null {
  if (argv.length !== 2 || argv[0] !== "--port" || !/^\d+$/.test(argv[1]!)) return null;
  const port = Number(argv[1]);
  return port <= 65535 ? port : null;
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2));
  if (port === null) {
    console.error(USAGE);
    process.exit(2);
  }

  const bridge = await startBridge({ dataDir: resolveDataDir(process.env), port });
  process.stdout.write(`${JSON.stringify({ event: "listening", address: bridge.address, port: bridge.port })}\n`);

  const shutdown = () => {
    bridge.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("voice-bridge: shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(`voice-bridge: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
