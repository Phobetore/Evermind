import { expect, test } from "vitest";
import { data } from "@/data";
import type { DataSource } from "@/data";

test("an edition may come without connections, a password or an update check", () => {
  const { characters, personas, conversations, messages, memories, turns, library, settings, file, device } = data;
  const bare: DataSource = {
    characters, personas, conversations, messages, memories, turns, library, settings, file, device,
  };
  expect(bare.connections).toBeUndefined();
  expect(bare.access).toBeUndefined();
  expect(bare.updates).toBeUndefined();
});
