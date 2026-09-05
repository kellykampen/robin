/** Animate stderr only; keep redirected output readable and stdout machine-safe. */
export function startSpinner(label: string, stream: { isTTY?: boolean; write: (text: string) => unknown } = process.stderr): () => void {
  if (!stream.isTTY) {
    stream.write(`${label}...\n`);
    return () => undefined;
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;
  const render = () => stream.write(`\r\u001b[2K${frames[index++ % frames.length]} ${label}`);
  render();
  const timer = setInterval(render, 80);
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stream.write("\r\u001b[2K");
  };
}
