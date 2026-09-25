// child_process stand-in. pythonlib's subprocess module imports spawn and spawnSync;
// the loop never runs a subprocess, and a browser cannot, so both throw if called.
function unavailable() {
  throw new Error("running subprocesses is not available in the browser");
}
export const spawn = unavailable;
export const spawnSync = unavailable;
export const exec = unavailable;
export const execSync = unavailable;
export const execFile = unavailable;
export const execFileSync = unavailable;
export default { spawn, spawnSync, exec, execSync, execFile, execFileSync };
