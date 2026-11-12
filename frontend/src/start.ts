import type { DeviceStore } from "@/data";

/** Draws the interface once what the device keeps can be read, since the language to draw it in is
 *  kept there. A store that cannot be read is said, rather than left as a blank page. */
export function start(
  device: Pick<DeviceStore, "ready">,
  render: () => void,
  renderFailure: (error: unknown) => void,
): Promise<void> {
  return device.ready.then(render, renderFailure);
}
