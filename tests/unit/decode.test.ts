import { test, expect } from "@playwright/test";
import { decode, inferName, isRawImage, unwrap } from "../../src/sorter/decode.ts";
import { OrdolineError, errorCodeOf, messageOf } from "../../src/sorter/errors.ts";
import { rgb } from "./fakes.ts";

test("unwrap separates tagged inputs from plain images", () => {
  const raw = rgb(2, 2);
  expect(unwrap(raw)).toEqual({ image: raw, id: null, name: null }); // raw pixels are not mistaken for {image}
  expect(unwrap({ image: "a.jpg", id: 7, name: "A" })).toEqual({ image: "a.jpg", id: "7", name: "A" });
  expect(unwrap({ image: "a.jpg" })).toEqual({ image: "a.jpg", id: null, name: null });
  const file = new File([new Uint8Array(1)], "x.png");
  expect(unwrap(file).image).toBe(file);
});

test("names are taken from files and URLs", () => {
  expect(inferName(new File([], "IMG_0001.JPG"))).toBe("IMG_0001.JPG");
  expect(inferName("https://x.test/photos/IMG%20001.jpg?v=2#top")).toBe("IMG 001.jpg");
  expect(inferName("/a/b/c.png")).toBe("c.png");
  expect(inferName({ currentSrc: "https://x.test/p/z.webp", src: "" })).toBe("z.webp");
  for (const anon of ["data:image/png;base64,AAA", "blob:https://x.test/uuid", "https://x.test/", new Blob([]), rgb(1, 1)]) {
    expect(inferName(anon)).toBeNull();
  }
  expect(inferName("https://x.test/%E0%A4%A.jpg")).toBeNull(); // malformed escape
});

test("raw pixels are recognized and passed through without decoding", async () => {
  const raw = rgb(3, 2);
  expect(isRawImage(raw)).toBe(true);
  expect(isRawImage({ data: [1, 2, 3], width: 1, height: 1 })).toBe(false); // plain array, not a typed array
  expect(isRawImage({ data: new Uint8Array(3), width: 1.5, height: 1 })).toBe(false);
  expect(await decode(raw)).toBe(raw);
});

test("error codes and messages are extracted from anything thrown", () => {
  const e = new OrdolineError("FETCH_FAILED", "nope", new Error("cause"));
  expect(e).toBeInstanceOf(Error);
  expect([e.name, e.code, (e.cause as Error).message]).toEqual(["OrdolineError", "FETCH_FAILED", "cause"]);
  expect(errorCodeOf(e, "INFERENCE_FAILED")).toBe("FETCH_FAILED");
  expect(errorCodeOf({ code: "DISPOSED" }, "INFERENCE_FAILED")).toBe("DISPOSED"); // came over postMessage
  expect(errorCodeOf(new Error("x"), "INFERENCE_FAILED")).toBe("INFERENCE_FAILED");
  expect(errorCodeOf(null, "DECODE_FAILED")).toBe("DECODE_FAILED");
  expect([messageOf(new Error("m")), messageOf("s"), messageOf(42)]).toEqual(["m", "s", "42"]);
});
