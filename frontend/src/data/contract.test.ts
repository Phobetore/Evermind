import { expect, test } from "vitest";
import { data } from "@/data";
import type { DataSource } from "@/data";

test("an edition may come without connections, a password, an update check or spending", () => {
  const { characters, personas, conversations, messages, memories, turns, library, settings, ways, file, device } = data;
  const bare: DataSource = {
    characters, personas, conversations, messages, memories, turns, library, settings, ways, file, device,
    remoteImages: false,
  };
  expect(bare.connections).toBeUndefined();
  expect(bare.access).toBeUndefined();
  expect(bare.updates).toBeUndefined();
  expect(bare.spending).toBeUndefined();
});

test("the server's edition shows an image of another site on a tap", () => {
  expect(data.remoteImages).toBe(true);
});
