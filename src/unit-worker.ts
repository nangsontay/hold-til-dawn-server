import { ports, readConfig, type Port } from './config.js';
import { readLease, workerCommand } from './worker-process.js';

try {
  const port = Number(process.argv[2]) as Port;
  if (!ports.includes(port)) throw Error();
  const config = readConfig();
  const lease = readLease(config, port);
  if (!lease || Date.now() >= lease.launchDeadline || !process.execve) throw Error();
  const { args, env } = workerCommand(config, port, lease);
  process.execve(config.workerExecutable, [config.workerExecutable, ...args], env);
} catch {
  console.error('Could not launch configured match worker');
  process.exitCode = 1;
}
