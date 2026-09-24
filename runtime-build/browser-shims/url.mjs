// url stand-in: the package only turns import.meta.url into a path to find its
// packaged data directory.
export function fileURLToPath(url) {
  return decodeURIComponent(new URL(String(url)).pathname);
}
export function pathToFileURL(path) {
  return new URL("file://" + path);
}
export default { fileURLToPath, pathToFileURL };
