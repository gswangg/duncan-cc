const mb = Number(process.argv[2] ?? "4");
const sleepMs = Number(process.argv[3] ?? "120");

const bytes = Math.max(1, Math.floor(mb * 1024 * 1024));
const buffer = Buffer.alloc(bytes, 1);
for (let i = 0; i < buffer.length; i += 4096) {
  buffer[i] = 1;
}

await new Promise((resolve) => setTimeout(resolve, sleepMs));
process.stdout.write(JSON.stringify({ pid: process.pid, bytes: buffer.length }) + "\n");
