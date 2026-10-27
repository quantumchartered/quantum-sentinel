// JSON.rawJSON ships in Node >= 21 (V8) but is not yet in the TypeScript ES lib.
interface RawJSON {
  readonly rawJSON: string;
}
interface JSON {
  rawJSON(text: string): RawJSON;
}
