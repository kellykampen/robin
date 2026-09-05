import { startSpinner } from "./spinner";
afterEach(() => jest.useRealTimers());
test("animates on a terminal and clears its timer and line on stop", () => {
  jest.useFakeTimers();
  const write = jest.fn(); const stop = startSpinner("Reviewing", { isTTY: true, write });
  expect(write).toHaveBeenCalled(); const first = write.mock.calls[0][0];
  jest.advanceTimersByTime(100); expect(write.mock.calls[1][0]).not.toBe(first);
  stop(); expect(write).toHaveBeenLastCalledWith("\r\u001b[2K");
  const calls = write.mock.calls.length; jest.advanceTimersByTime(500); expect(write).toHaveBeenCalledTimes(calls);
});
test("non-terminal output has one plain progress line and no animation", () => {
  jest.useFakeTimers(); const write = jest.fn(); const stop = startSpinner("Reviewing", { write });
  jest.advanceTimersByTime(500); stop(); expect(write.mock.calls).toEqual([["Reviewing...\n"]]);
});
