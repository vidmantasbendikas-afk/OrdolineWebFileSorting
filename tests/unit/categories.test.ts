import { test, expect } from "@playwright/test";
import { CATEGORIES, CLASS_TO_CATEGORY, DEFAULT_CLASSES, LABELS, classToCategory } from "../../src/sorter/categories.ts";
import { defaultThreads, parseClassNames, sessionInputSize, type OrtSession } from "../../src/sorter/runtime.ts";
import { CLASS_NAMES, namesMetadata, stubGlobal } from "./fakes.ts";

test("the 11 categories are unique, labelled and frozen", () => {
  expect(CATEGORIES).toHaveLength(11);
  expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(11);
  for (const c of CATEGORIES) expect(LABELS[c.id]).toBe(c.label);
  expect(Object.isFrozen(CATEGORIES)).toBe(true);
  expect(Object.isFrozen(CATEGORIES[0])).toBe(true);
});

test("every model class maps to its own category", () => {
  expect(DEFAULT_CLASSES).toEqual(CLASS_NAMES);
  const mapped = DEFAULT_CLASSES.map(classToCategory);
  expect(new Set(mapped).size).toBe(11);
  for (const cls of DEFAULT_CLASSES) expect(classToCategory(cls)).toBe(CLASS_TO_CATEGORY[cls]);
});

test("unknown class names fall back to suffix rules, most specific first", () => {
  expect(classToCategory("new_profile_smile")).toBe("extraoral_profile_smile"); // not "smile"
  expect(classToCategory("new_profile_rest")).toBe("extraoral_profile_rest"); // not "rest"
  expect(classToCategory("xray_ceph_front")).toBe("cephalometric_frontal"); // not "front"
  expect(classToCategory("ceph_lateral")).toBe("cephalometric_lateral");
  expect(classToCategory("intraoral_left_v2")).toBe("intraoral_left");
  expect(classToCategory("occlusal_upper")).toBe("intraoral_upper");
  expect(classToCategory("something_else")).toBe(CATEGORIES[0].id);
});

test("class names are read from the model metadata in index order", () => {
  expect(parseClassNames(namesMetadata(CLASS_NAMES))).toEqual(CLASS_NAMES);
  expect(parseClassNames({ names: "{2: 'c', 0: 'a', 1: 'b'}" })).toEqual(["a", "b", "c"]);
  for (const meta of [null, undefined, {}, { names: "" }, { names: "not a dict" }]) expect(parseClassNames(meta)).toBeNull();
});

test("input size comes from the model, 384 when unknown", () => {
  const session = (dims?: ReadonlyArray<number | string>) => ({ inputMetadata: dims && [{ dims }] }) as unknown as OrtSession;
  expect(sessionInputSize(session([1, 3, 224, 224]))).toBe(224);
  expect(sessionInputSize(session([1, 3, "height", "width"]))).toBe(384);
  expect(sessionInputSize(session())).toBe(384);
});

test("default threads: one core left for the page, at most 4", () => {
  for (const [cores, threads] of [[1, 1], [2, 1], [4, 3], [8, 4], [22, 4], [0, 3]]) {
    const restore = stubGlobal("navigator", { hardwareConcurrency: cores });
    try { expect(defaultThreads(), `${cores} cores`).toBe(threads); } finally { restore(); }
  }
});
