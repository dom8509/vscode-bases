import type { FileInfo } from "../src/core/expr";
import { parseRecord, type FileRecord } from "../src/core/record";

export function fileInfo(path: string, mtime = Date.UTC(2026, 0, 15)): FileInfo {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    ext: dot > 0 ? name.slice(dot + 1) : "",
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    mtime,
    ctime: mtime,
    size: 100,
  };
}

export function record(path: string, text: string): FileRecord {
  return parseRecord(`file:///ws/${path}`, fileInfo(path), text)!;
}
