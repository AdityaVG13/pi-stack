import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { engineFixture } from "../helpers/engine.mjs";

async function assertEditableDeclaration(t, { extension, source, replacement, neighbor, runtime }) {
  const f = t._fixture ??= await engineFixture(t);
  const filename = "payload-token." + extension;
  const selector = JSON.stringify({ path: filename, query: "payloadToken", resolve: true });
  const text = source.endsWith("\n") ? source : source + "\n";
  const next = neighbor ?? "\nexport function otherToken() { return 99; }\n";

  if (runtime) assert.equal(runtime(text), true);
  await f.write(filename, text + next);
  const view = (await f.execute("return await read(" + selector + ");")).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.text, text);
  assert.deepEqual(view.lines, [1, text.trimEnd().split("\n").length]);
  const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
  assert.equal(edited.isError, undefined);
  assert.doesNotMatch(edited.details.result, /check:/);
  assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + next);
}

it("TypeScript next-line extends operands retain complete editable views", async t => {
  for (const extension of ["ts", "tsx"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const body of [
        "T extends\n  string ? T : never",
        "T extends\n  // constraint follows\n  string ? T : never",
        "T extends\n  { a: number } ? T : never",
      ]) {
        const source = ("export type payloadToken<T> = " + body + ";\n").replaceAll("\n", newline);
        const replacement = "export type payloadToken<T> = T;" + newline;
        await assertEditableDeclaration(t, { extension, source, replacement });
      }
    }
  }
});

it("TypeScript generic extends constraints retain complete editable views", async t => {
  for (const extension of ["ts", "tsx"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const header of [
        "<T extends\n  { a: number }>",
        "<T extends\n  // constraint follows\n  { a: number }>",
        "<T extends keyof\n  { a: number }>",
      ]) {
        const source = ("export type payloadToken" + header + " = T;\n").replaceAll("\n", newline);
        const replacement = "export type payloadToken<T> = T;" + newline;
        await assertEditableDeclaration(t, { extension, source, replacement });
      }
    }
  }
});

it("TypeScript abstract constructor types retain complete editable views", async t => {
  const { stripTypeScriptTypes } = await import("node:module");

  for (const extension of ["ts", "tsx"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const source of [
        "export const payloadToken: abstract\n  new () => number = Number;\n",
        "export const payloadToken: abstract\n  // constructor type follows\n  new () => number = Number;\n",
        "export type payloadToken = abstract\n  new () => number;\n",
      ]) {
        const text = source.replaceAll("\n", newline);

        const replacement = source.startsWith("export type")
          ? "export type payloadToken = number;" + newline
          : "export const payloadToken = Number;" + newline;

        await assertEditableDeclaration(t, {
          extension,
          source: text,
          replacement,
          runtime: source.startsWith("export type")
            ? undefined
            : src => new Function(stripTypeScriptTypes(src.replace("export ", "")) + "return payloadToken === Number;")(),
        });
      }
    }
  }
});

it("TypeScript infer conditional types retain complete editable views", async t => {
  for (const extension of ["ts", "tsx"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const body of [
        "T extends infer\n  U ? U : never",
        "T extends infer\n  // inferred name follows\n  U ? U : never",
      ]) {
        const source = ("export type payloadToken<T> = " + body + ";\n").replaceAll("\n", newline);
        const replacement = "export type payloadToken<T> = T;" + newline;
        await assertEditableDeclaration(t, { extension, source, replacement });
      }
    }
  }
});

it("TypeScript type-alias operand prefixes retain complete editable views", async t => {
  for (const extension of ["ts", "tsx"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const body of [
        "keyof\n  { answer: number }",
        "keyof\n  // type operand follows\n  { answer: number }",
        "readonly\n  number[]",
        "unique\n  symbol",
      ]) {
        const source = ("export type payloadToken = " + body + ";\n").replaceAll("\n", newline);
        const replacement = "export type payloadToken = number;" + newline;
        await assertEditableDeclaration(t, { extension, source, replacement });
      }
    }
  }
});

it("TypeScript unique symbol annotations retain complete editable binding views", async t => {
  const f = await engineFixture(t);
  const { stripTypeScriptTypes } = await import("node:module");

  for (const extension of ["ts", "tsx"]) {
    const filename = "unique-symbol-binding." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const annotation of [
        ": unique\n  symbol",
        ": unique\n  // symbol type follows\n  symbol",
        ": unique symbol",
      ]) {
        const declaration = ("export const payloadToken" + annotation + " = Symbol('payload');\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = Symbol('replacement');" + newline;
        assert.equal(new Function(stripTypeScriptTypes(declaration.replace("export ", "")) + "return typeof payloadToken;")(), "symbol");
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  for (const extension of ["js", "ts"]) {
    const filename = "unique-identifier." + extension;
    const declaration = "export const payloadToken = unique\n";
    const neighbor = "{ const separateToken = 2; }\nexport function otherToken() { return 99; }\n";
    const replacement = "export const payloadToken = 0;\n";
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
    assert.equal(new Function("const unique = 42;\n" + declaration.replace("export ", "") + neighbor.replace("export ", "") + "return payloadToken;")(), 42);
    await f.write(filename, declaration + neighbor);
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, declaration);
    await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
  }
});

it("TypeScript readonly array annotations retain complete editable binding views", async t => {
  const f = await engineFixture(t);
  const { stripTypeScriptTypes } = await import("node:module");

  for (const extension of ["ts", "tsx"]) {
    const filename = "readonly-binding." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const annotation of [
        ": readonly\n  number[]",
        ": readonly\n  // array element type follows\n  number[]",
        ": readonly\n  (number | string)[]",
        ": readonly number[]",
        ": readonly\n  [number, number]",
      ]) {
        const declaration = ("export const payloadToken" + annotation + " = [40, 2];\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = [42];" + newline;
        assert.equal(new Function(stripTypeScriptTypes(declaration.replace("export ", "")) + "return payloadToken.reduce((a, b) => a + b, 0);")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  for (const extension of ["js", "ts"]) {
    const filename = "readonly-identifier." + extension;
    const declaration = "export const payloadToken = readonly\n";
    const neighbor = "{ const separateToken = 2; }\nexport function otherToken() { return 99; }\n";
    const replacement = "export const payloadToken = 0;\n";
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
    assert.equal(new Function("const readonly = 42;\n" + declaration.replace("export ", "") + neighbor.replace("export ", "") + "return payloadToken;")(), 42);
    await f.write(filename, declaration + neighbor);
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, declaration);
    await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
  }
});

it("TypeScript keyof object-annotated bindings retain their initializer in editable views", async t => {
  const f = await engineFixture(t);
  const { stripTypeScriptTypes } = await import("node:module");

  for (const extension of ["ts", "tsx"]) {
    const filename = "keyof-binding." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const annotation of [
        ": keyof {\n  answer: number;\n}",
        ": keyof\n  // type operand follows\n  {\n    answer: number;\n  }",
        ": keyof keyof {\n  answer: number;\n}",
      ]) {
        const value = annotation.includes("keyof keyof") ? '"toString"' : '"answer"';
        const declaration = ("export const payloadToken" + annotation + " = " + value + ";\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 'replacement';" + newline;
        assert.equal(new Function(stripTypeScriptTypes(declaration.replace("export ", "")) + "return payloadToken;")(), JSON.parse(value));
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  for (const extension of ["js", "ts"]) {
    const filename = "keyof-identifier." + extension;
    const declaration = "export const payloadToken = keyof\n";
    const neighbor = "{ const separateToken = 2; }\nexport function otherToken() { return 99; }\n";
    const replacement = "export const payloadToken = 0;\n";
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
    assert.equal(new Function("const keyof = 42;\n" + declaration.replace("export ", "") + neighbor.replace("export ", "") + "return payloadToken;")(), 42);
    await f.write(filename, declaration + neighbor);
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, declaration);
    await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
  }
});

it("TypeScript object-annotated bindings retain their initializer in editable views", async t => {
  const f = await engineFixture(t);
  const { stripTypeScriptTypes } = await import("node:module");

  for (const extension of ["ts", "tsx"]) {
    const filename = "typed-binding." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const annotation of [
        ": {\n  value: number;\n}",
        ":\n  // annotation follows\n  {\n    value: number;\n  }",
      ]) {
        const declaration = ("export const payloadToken" + annotation + " = {\n  value: 42\n};\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = { value: 0 };" + newline;
        assert.equal(new Function(stripTypeScriptTypes(declaration.replace("export ", "")) + "return payloadToken.value;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export let payloadToken: {\n  value: number;\n};\n".replaceAll("\n", newline);
      const neighbor = "{ const separateToken = 2; }" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = 0;" + newline;
      stripTypeScriptTypes(declaration);
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("JS/TS leading assignment operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "leading-assignment." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "holder.value\n  = 42",
        "holder.value\n  // assignment follows\n  /* operator */ =\n    42",
        "holder.value\n  = holder.other\n  = 42",
      ]) {
        const prefix = "const holder = { value: 0, other: 0 };" + newline;
        const declaration = ("export const payloadToken = " + initializer + ";\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(prefix + declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, prefix + declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [2, 1 + declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
      }

      const declaration = "export const payloadToken = holder.value;" + newline;
      const prefix = "const holder = { value: 0 };" + newline;
      const neighbor = "holder.value = 42;" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = 0;" + newline;
      await f.write(filename, prefix + declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
    }
  }
});

it("JS/TS trailing member operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "trailing-members." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "Math.\n  max(40, 42)",
        "Math?.\n  max(40, 42)",
        "Math.\n  // property follows\n  /* member */ max(40, 42)",
        "({ value1: { answer: 42 } }).value1.\n  answer",
        "42..\n  valueOf()",
        "0x2a.\n  valueOf()",
        "42n.\n  valueOf()",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + ";\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(Number(new Function(declaration.replace("export ", "") + "return payloadToken;")()), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const literal of ["42.", "4.2e1", "4.2e+1", "4_2."]) {
        const declaration = "export const payloadToken = " + literal + newline;
        const neighbor = "standaloneToken;" + newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, declaration);
        await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("JS/TS block-arrow bindings retain subsequent declarators in editable views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "arrow-declarators." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const tail of [
        "\n  , siblingToken = 2;",
        "\n  // next declarator\n  /* comma */ , siblingToken =\n    2;",
        ", siblingToken =\n  2;",
      ]) {
        const declaration = ("export const payloadToken = () => {\n  return /[}]/.test('}') ? 40 : 0;\n}" + tail + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = () => 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken() + siblingToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = ("export const payloadToken = () => {\n  return 40;\n};\n").replaceAll("\n", newline);
      const neighbor = "{ const separateToken = 2; }" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = () => 0;" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("TypeScript interfaces with next-line heritage retain complete editable views", async t => {
  const f = await engineFixture(t);
  const { stripTypeScriptTypes } = await import("node:module");

  for (const extension of ["ts", "tsx"]) {
    const filename = "interface-heritage." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const header of [
        "export interface payloadToken\n  extends Record<string, number>",
        "export interface payloadToken\n  // heritage follows\n  /* base */ extends Record<string, number>",
        "export interface payloadToken<T = number>\n  extends Record<string, T>",
        "export interface payloadToken\n  extends\n    Record<string, number>",
      ]) {
        const declaration = (header + " {\n  value: " + (header.includes("<T") ? "T" : "number") + ";\n}\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export interface payloadToken { updated: number; }" + newline;
        assert.equal(new Function(stripTypeScriptTypes(declaration + neighbor).replace("export ", "") + "return otherToken();")(), 99);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("a parent declaration span still includes its nested body", async t => {
  const f = await engineFixture(t);
  await f.write("nest.js", `export function outerToken() {
  function hiddenInner(s) { return s; }
  return hiddenInner("x");
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"outerToken", resolve:true});')).details.result;
  assert.equal(source.status, "found");
  assert.equal(source.path, "nest.js");
  assert.match(source.text, /^export function outerToken/);
  assert.match(source.text, /hiddenInner/);
  assert.match(source.text, /return hiddenInner/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.equal(source.complete, false);
  await f.execute(`
    const v = await read({query:"outerToken", resolve:true});
    await edit(v, "export function outerToken() { return 0; }\\n");
  `);
  const after = await fs.readFile(path.join(f.root, "nest.js"), "utf8");
  assert.match(after, /export function outerToken\(\) \{ return 0; \}/);
  assert.match(after, /export function otherToken/);
  assert.doesNotMatch(after, /hiddenInner/);
});

it("one-line class methods resolve to that method, not the class", async t => {
  const f = await engineFixture(t);
  await f.write("klass.js", `export class Host {
  constructor() { this.x = 1; }
  fetchSpan(path) { return path; }
  writeSpan(path) { return path; }
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"fetchSpan", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "klass.js");
  assert.match(source.text, /fetchSpan\(path\) \{ return path; \}/);
  assert.doesNotMatch(source.text, /writeSpan/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.doesNotMatch(source.text, /export class Host/);
  assert.equal(source.complete, false);
});

it("two exact declarations of the same name in one file are ambiguous", async t => {
  const f = await engineFixture(t);
  await f.write("twins.js", `export function outerToken() {
  function twinToken(s) { return s; }
  return twinToken("x");
}

export function twinToken(selector) {
  return selector;
}
`);
  const source = (await f.execute('return await read({query:"twinToken", resolve:true});')).details.result;
  assert.equal(source.status, "ambiguous", JSON.stringify(source));
  assert.equal(source.path, null);
  assert.equal(source.text, undefined);
  assert.ok(source.candidates?.length >= 2, "both the inner and exported twinToken must be candidates");
  const inner = source.candidates.find(row => row.line === 2);
  const exported = source.candidates.find(row => row.line === 6);
  assert.ok(inner, JSON.stringify(source.candidates));
  assert.ok(exported, JSON.stringify(source.candidates));
  assert.match(inner.signature, /function twinToken\(s\)/);
  assert.match(exported.signature, /export function twinToken\(selector\)/);
  assert.deepEqual(inner.lines, [2, 2]);
  assert.deepEqual(exported.lines, [6, 8]);
  assert.match(inner.text, /function twinToken\(s\) \{ return s; \}/);
  assert.match(exported.text, /export function twinToken\(selector\)/);
  assert.doesNotMatch(exported.text, /outerToken/);
  assert.ok(exported.context.some(row => row.includes("►6") && row.includes("export function twinToken")));
  assert.ok(!exported.context.some(row => row.includes("►") && row.includes("function twinToken(s)")));
});

it("cross-file ambiguous candidates are each declaration's span", async t => {
  const f = await engineFixture(t);
  await f.write("a.js", "export function duplicateToken() { return \"alpha\"; }\n");
  await f.write("b.js", "export function duplicateToken() { return \"beta\"; }\n");
  const source = (await f.execute('return await read({query:"duplicateToken", resolve:true});')).details.result;
  assert.equal(source.status, "ambiguous");
  assert.equal(source.path, null);
  assert.equal(source.text, undefined);
  const alpha = source.candidates.find(row => row.path === "a.js");
  const beta = source.candidates.find(row => row.path === "b.js");
  assert.ok(alpha, JSON.stringify(source.candidates));
  assert.ok(beta, JSON.stringify(source.candidates));
  assert.match(alpha.signature, /export function duplicateToken/);
  assert.match(beta.signature, /export function duplicateToken/);
  assert.match(alpha.text, /alpha/);
  assert.match(beta.text, /beta/);
  assert.doesNotMatch(alpha.text, /beta/);
  assert.doesNotMatch(beta.text, /alpha/);
  assert.deepEqual(alpha.lines, [1, 1]);
  assert.deepEqual(beta.lines, [1, 1]);
});

it("a declaration span does not close on braces inside strings or comments", async t => {
  const f = await engineFixture(t);
  await f.write("braces.js", `export function braceToken() {
  const close = "}";
  // }
  return close;
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"braceToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "braces.js");
  assert.match(source.text, /^export function braceToken/);
  assert.match(source.text, /const close = "\}"/);
  assert.match(source.text, /return close/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 5]);
  await f.execute(`
    const v = await read({query:"braceToken", resolve:true});
    await edit(v, "export function braceToken() { return 0; }\\n");
  `);
  const after = await fs.readFile(path.join(f.root, "braces.js"), "utf8");
  assert.match(after, /export function braceToken\(\) \{ return 0; \}/);
  assert.match(after, /export function otherToken/);
  assert.doesNotMatch(after, /const close/);
});

it("JS/TS next-line keyword binary operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "keyword-binary-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        '"answer"\n  in {answer:42};',
        '"answer"\n  // membership follows\n  /* operand */ in {answer:42};',
        'new Date()\n  instanceof Date;',
        'new Date()\n  // constructor follows\n  /* operand */ instanceof Date;',
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = false;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), true);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const identifier of ["inValue", "instanceofValue", "in$", "instanceofπ", String.raw`in\u0061`]) {
        const declaration = "export const payloadToken = 42" + newline;
        const neighbor = identifier + ";" + newline + "export function otherToken() { return 99; }" + newline;
        new Function(declaration.replace("export ", "") + neighbor.replace("export ", ""));
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, declaration, "a following identifier statement stays separate: " + identifier);
      }
    }
  }
});

it("JS/TS next-line bitwise operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "bitwise-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "40\n  | 2;",
        "43\n  // operand follows\n  /* mask */ & 42;",
        "40\n  ^ 2;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export const payloadToken = 40;" + newline;
      const neighbor = "// separate statement" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = 0;" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("JS/TS next-line arrow bodies retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "arrow-body-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "() =>\n  42;",
        "value =>\n  // body follows\n  /* operand */ value + 2;",
        "async () =>\n  42;",
        "() =>\n  { return 42; };",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = () => 0;" + newline;
        assert.equal(await new Function(declaration.replace("export ", "") + "return payloadToken(40);")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export const payloadToken = () => 42;" + newline;
      const neighbor = "{ console.log('separate block'); }" + newline + "export function otherToken() { return 99; }" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify("export const payloadToken = () => 0;" + newline) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), "export const payloadToken = () => 0;" + newline + neighbor);
    }
  }
});

it("JS/TS array initializers retain trailing expression continuations in editable views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "array-continuation." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "[40, 2]\n  .reduce((a, b) => a + b, 0);",
        "[\n  40,\n  2\n].reduce((a, b) => a + b, 0);",
        "[40, 2]\n  // sum follows\n  /* member */ .reduce((a, b) => a + b, 0);",
        "[40, 2]\n  [0] + 2;",
        "[40]\n  + 2;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), initializer.includes("+ 2;") && !initializer.includes("[0]") ? "402" : 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const terminator of ["", ";"]) {
        const declaration = "export const payloadToken = [40, 2]" + terminator + newline;
        const neighbor = "{ console.log('separate block'); }" + newline + "export function otherToken() { return 99; }" + newline;
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, declaration);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify("export const payloadToken = 0;" + newline) + ");");
        assert.equal(edited.isError, undefined);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), "export const payloadToken = 0;" + newline + neighbor);
      }
    }
  }
});

it("JS/TS leading declarator commas retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "declarator-comma." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "40\n  , companionToken = 2;",
        "40\n  // another declarator\n  /* comma */ , companionToken =\n    2;",
        "40\n  , companionToken = 1\n  , finalToken = 1;",
        "40,\n  companionToken = 2;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken + companionToken + (typeof finalToken === 'undefined' ? 0 : finalToken);")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export const payloadToken = 40;" + newline;
      const neighbor = "console.log(1," + newline + "  2);" + newline + "export function otherToken() { return 99; }" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
    }
  }
});

it("JS/TS next-line constructor operands retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "constructor-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "new\n  Number(42);",
        "new\n  // constructor follows\n  /* operand */ Number(42);",
        "new\n  Number\n  (42);",
        "new\n  class { valueOf() { return 42; } };",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return Number(payloadToken);")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const initializer of ["new Number(42)", "({new:42}).new"]) {
        const declaration = "export const payloadToken = " + initializer + newline;
        const neighbor = "{ console.log('separate block'); }" + newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, declaration);
        await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("JS/TS next-line computed members retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "computed-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "Math\n  [\"max\"](42, 0);",
        "Math\n  // key follows\n  /* member */ [\"max\"](42, 0);",
        "Math\n  [\n    \"max\"\n  ](42, 0);",
        "Math\n  [\"max\"]\n  (42, 0);",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export const payloadToken = Math;" + newline;
      const neighbor = "[\"standalone\"];" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = 0;" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("JS/TS wrapped call initializers retain trailing expression continuations", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "wrapped-call-continuation." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "Math.max(\n  40,\n  0\n)\n  + 2;",
        "Math.max(\n  40,\n  0\n) +\n  2;",
        "Math.max\n  (\n    40,\n    0\n  )\n  /* continuation */ + 2;",
        "(\n  40\n)\n  + 2;",
        "Math.max(\n  Math.min(40, 50),\n  0\n)\n  .toString();",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), initializer.includes("toString") ? "40" : 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("JS/TS next-line calls retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "call-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "Math.max\n  (42, 0);",
        "Math.max\n  // arguments follow\n  /* call */ (42, 0);",
        "Math.max\n  (\n    42,\n    0\n  );",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export const payloadToken = Math.max;" + newline;
      const neighbor = "(42);" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = 0;" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("JS/TS next-line tagged templates retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "tagged-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "String.raw\n  `4${2}`;",
        "String.raw\n  // template follows\n  /* payload */ `4\n2`;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        const expectedValue = initializer.includes("${") ? "42" : "4\n2";
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), expectedValue);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = "export const payloadToken = String.raw;" + newline;
      const neighbor = "`standalone" + newline + "template`;" + newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export const payloadToken = 0;" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("JS/TS next-line conditional operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "conditional-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "true\n  ? 42 : 0;",
        "true ? 42\n  : 0;",
        "false\n  ? 0\n  : 42;",
        "true\n  // condition follows\n  /* value */ ? false\n    ? 0\n    : 42\n  : 1;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const complete = "export const payloadToken = 42" + newline;
      const separate = "label: { globalThis.counter = true ? 1 : 0; }" + newline;
      await f.write(filename, complete + separate);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, complete, "a following labeled statement stays separate");
      const replacement = "export const payloadToken = 0;" + newline;
      await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + separate);
    }
  }
});

it("JS/TS leading comparison operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "comparison-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "40\n  < 42;",
        "42\n  <= 42;",
        "44\n  > 42;",
        "42\n  >= 42;",
        "42\n  == 42;",
        "40\n  != 42;",
        "42\n  === 42;",
        "40\n  !== 42;",
        "40\n  // comparison follows\n  /* operand */ < 42;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = false;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), true);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      // Unary negation is a separate statement, not an equality continuation.
      const declaration = "export const payloadToken = 42" + newline;
      const neighbor = "!false;" + newline + "export function otherToken() { return 99; }" + newline;
      await f.write(filename, declaration + neighbor);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      const replacement = "export const payloadToken = 0;" + newline;
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("JS/TS leading logical operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "logical-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "true\n  && 42;",
        "false\n  || 42;",
        "null\n  ?? 42;",
        "null\n  // operator follows\n  /* value */ ?? null\n  ?? 42;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("JS/TS leading multiplicative operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "multiplicative-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "6\n  * 7;",
        "84\n  / 2;",
        "86\n  % 44;",
        "2\n  ** 5 + 10;",
        "84\n  // operator follows\n  /* value */ / 2;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.equal(new Function(declaration.replace("export ", "") + "return payloadToken;")(), 42);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const complete = "export const payloadToken = 42;" + newline;
      const separate = '/[}]/.test("}");' + newline;
      await f.write(filename, complete + separate);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, complete, "a terminated binding must not absorb a separate regex statement");
      const replacement = "export const payloadToken = 0;" + newline;
      await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + separate);
    }
  }
});

it("JS/TS leading additive operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "additive-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "40\n  + 2;",
        "44\n  - 2;",
        "40\n  // operator follows\n  /* value */ + 3\n  - 1;",
        "40\n  + +2;",
        "44\n  - -2;",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        assert.doesNotThrow(() => new Function(declaration.replace("export ", "") + "return payloadToken;")());
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const [terminator, separate] of [[";", "+2;"], [";", "-2;"], ["", "++globalThis.counter;"], ["", "--globalThis.counter;"]]) {
        const complete = "export const payloadToken = 42" + terminator + newline;
        await f.write(filename, complete + separate + newline);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, complete, "terminated initializers and next-line updates stay separate");
        await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify("export const payloadToken = 0;" + newline) + ");");
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), "export const payloadToken = 0;" + newline + separate + newline);
      }
    }
  }
});

it("JS/TS next-line member accesses retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "member-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of [
        "Math\n  .max(42, 0);",
        "Math\n  ?.max(42, 0);",
        "Math\n  // member follows\n  /* value */ .max\n  // next member follows\n  ?.call(null, 42, 0);",
      ]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const terminator of [";", ""]) {
        const complete = "export const payloadToken = 42" + terminator + newline;
        const separate = ".5;" + newline;
        await f.write(filename, complete + separate);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, complete, "a leading decimal point is not member access");
        await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify("export const payloadToken = 0;" + newline) + ");");
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), "export const payloadToken = 0;" + newline + separate);
      }
    }
  }
});

it("JS/TS trailing binary operators retain complete editable binding views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "binary-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of ["40 +\n  2;", "84 /\n  2;", "true &&\n  Math.max(42, 0);", "40 +\n  // operand follows\n  /* value */ 1 +\n  1;"]) {
        const declaration = ("export const payloadToken = " + initializer + "\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export const payloadToken = 0;" + newline;
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const complete = "export const payloadToken = 40 + 2;" + newline;
      const separate = "{ const local = 1 + 2; }" + newline;
      await f.write(filename, complete + separate);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, complete, "a completed binary initializer must not absorb a separate block");
      await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify("export const payloadToken = 0;" + newline) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), "export const payloadToken = 0;" + newline + separate);
    }
  }
});

it("JS/TS next-line identifier binding initializers retain complete editable views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "identifier-initializer." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const initializer of ["Math.PI;", "Math.max(42, 0);", "Math.max(\n  42,\n  0,\n);"]) {
        for (const trivia of ["\n", "\n// initializer follows\n/* value */\n"]) {
          const declaration = ("export const payloadToken =" + trivia + "  " + initializer + "\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const source = declaration + neighbor;
          const replacement = "export const payloadToken = 0;" + newline;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }

      const complete = "export const payloadToken = Math.PI;" + newline;
      const separate = "{ const local = Math.max(42, 0); }" + newline;
      await f.write(filename, complete + separate);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, complete, "a completed binding must not absorb a separate block");
      await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify("export const payloadToken = 0;" + newline) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), "export const payloadToken = 0;" + newline + separate);
    }
  }
});

it("JS/TS multiline class heritage retains complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "class-heritage." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
    const headers = [
      "export class payloadToken\n  extends Object",
      "export class payloadToken extends\n  Object",
      "export class payloadToken\n  // heritage follows\n  extends\n  /* base */ Object",
      ...(extension === "js" ? [] : [
        "export class payloadToken\n  implements Object",
        "export class payloadToken extends Object\n  implements Object",
        "export class payloadToken<T>\n  extends Object\n  implements Object",
      ]),
    ];

    for (const newline of ["\n", "\r\n"]) {
      for (const header of headers) {
        const declaration = (header + " {\n  value = 42;\n}\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const source = declaration + neighbor;
        const replacement = "export class payloadToken {}" + newline;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("class-heritage-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  const { braceBlockEndLine } = await import("../../src/fs/check.js");
  const method = "  class(): number;\n";
  const implementation = "  class() {\n    return 42;\n  }\n";
  assert.equal(braceBlockEndLine(method + implementation, 1, ".ts", true), 1,
    "a method named class must not become an unfinished class header");
});

it("JS/TS next-line parameter openers retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts", "tsx"]) {
    const filename = "next-line-parameters." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const prefix of ["export function payloadToken", "export async function payloadToken", "export function* payloadToken"]) {
        for (const separator of ["\n", "\n// parameters follow\n/* header */\n"]) {
          const returnType = prefix.includes("async") ? "Promise<number>" : prefix.includes("*") ? "Generator<never, number, unknown>" : "number";
          const parameters = extension === "js" ? "(\n  value = 42,\n)" : "(\n  value: number = 42,\n): " + returnType;
          const declaration = (prefix + separator + parameters + " {\n  return value;\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const source = declaration + neighbor;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("next-line-parameters-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("TypeScript next-line generic openers retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const { braceBlockEndLine } = await import("../../src/fs/check.js");

  for (const extension of ["ts", "tsx"]) {
    const filename = "next-line-generics." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const kind of ["function", "class"]) {
        for (const separator of ["\n", "\n// generic follows\n/* header */\n"]) {
          for (const generic of ["<T>", "<\n  T extends { value: number },\n>"]) {
            const tail = kind === "function" ? "(value: T): T {\n  return value;\n}\n" : " {\n  value: T | undefined;\n}\n";
            const declaration = ("export " + kind + " payloadToken" + separator + generic + tail).replaceAll("\n", newline);
            const neighbor = newline + "export function otherToken() { return 99; }" + newline;
            const replacement = "export " + kind + " payloadToken" + (kind === "function" ? "() { return 0; }" : " {}") + newline;
            const source = declaration + neighbor;
            await f.write(filename, source);
            const view = (await f.execute("return await read(" + selector + ");")).details.result;
            assert.equal(view.status, "found");
            assert.equal(view.text, declaration, extension + ": " + declaration);
            assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
            const written = await f.tool.execute("next-line-generics-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
            assert.equal(written.isError, undefined);
            assert.doesNotMatch(written.details.result, /check:/);
            const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
            assert.equal(edited.isError, undefined);
            assert.doesNotMatch(edited.details.result, /check:/);
            assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
          }
        }
      }

      const overload = "export function payloadToken(): number;" + newline;
      const expression = ("<T,>(value: T) => {\n  return value;\n};\n").replaceAll("\n", newline);
      assert.equal(braceBlockEndLine(overload + expression, 1, "." + extension, true), 1,
        "a completed overload must not absorb a following generic arrow expression");
    }
  }
});

it("TypeScript wrapped overload views stop before their implementation", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "wrapped-overload." + extension;

    for (const newline of ["\n", "\r\n"]) {
      for (const terminator of ["", ";"]) {
        for (const returnType of ["number", "{ value: number }"]) {
          const overload = ("export function payloadToken(\n  value: number,\n): " + returnType + terminator + "\n").replaceAll("\n", newline);
          const implementation = ("export function payloadToken(value: number) {\n  return " + (returnType === "number" ? "value" : "{ value }") + ";\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken(value: number): " + returnType + ";" + newline;
          await f.write(filename, overload + implementation + neighbor);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const result = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(result.status, "ambiguous");
          const candidate = result.candidates.find(row => row.line === 1);
          assert.ok(candidate);
          assert.equal(candidate.text, overload.slice(0, -1), extension + ": " + overload);
          assert.deepEqual(candidate.lines, [1, 3]);
          const body = result.candidates.find(row => row.line === 4);
          assert.equal(body.text, implementation.slice(0, -1));
          assert.deepEqual(body.lines, [4, 6]);
          const edited = await f.execute("const r = await read(" + selector + "); const c = r.candidates.find(row => row.line === 1); const v = await read({path:c.path,offset:c.lines[0],limit:c.lines[1]-c.lines[0]+1,resolve:true}); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + implementation + neighbor);
        }
      }
    }
  }
});

it("TypeScript multiline generic headers retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const { braceBlockEndLine } = await import("../../src/fs/check.js");

  for (const extension of ["ts", "tsx"]) {
    const filename = "multiline-generic." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const generic of [
        "<\n  T,\n>",
        "<T,\n  U = T,\n>",
        "<\n  /* constraint */ T extends { value: number },\n>",
        "<\n  T extends Array<\n    number\n  >,\n>",
      ]) {
        for (const kind of ["function", "class"]) {
          const tail = kind === "function" ? "(value: T) {\n  return value;\n}\n" : " {\n  value: T | undefined;\n}\n";
          const declaration = ("export " + kind + " payloadToken" + generic + tail).replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export " + kind + " payloadToken" + (kind === "function" ? "() { return 0; }" : " {}") + newline;
          const source = declaration + neighbor;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("multiline-generic-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }

        for (const terminator of ["", ";"]) {
          const overload = ("export function payloadToken" + generic + "(value: T): T" + terminator + "\n").replaceAll("\n", newline);
          const implementation = ("export function payloadToken(value: unknown) {\n  return value;\n}\n").replaceAll("\n", newline);
          assert.equal(braceBlockEndLine(overload + implementation, 1, "." + extension, true), overload.trimEnd().split("\n").length,
            "a completed generic overload must not absorb its implementation");
        }
      }
    }
  }
});

it("TypeScript next-line assertion targets retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "assertion-return." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const signature of ["(value: unknown)", "(\n  value: unknown,\n)"]) {
        for (const type of ["asserts\n  value", "asserts\n  /* assertion target */ value is number", "asserts\n  value is { value: number }"]) {
          const declaration = ("export function payloadToken" + signature + ": " + type + "\n{\n  if (!value) throw new Error(\"value required\");\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          const source = declaration + neighbor;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("assertion-return-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);

          const overload = ("export function payloadToken(value: unknown): " + type + ";\n").replaceAll("\n", newline);
          const { braceBlockEndLine } = await import("../../src/fs/check.js");
          assert.equal(braceBlockEndLine(overload + declaration, 1, "." + extension, true), overload.trimEnd().split("\n").length,
            "a completed assertion overload must not absorb its implementation");
        }
      }
    }

    const { braceBlockEndLine } = await import("../../src/fs/check.js");

    for (const terminator of ["", ";"]) {
      const overload = "export function payloadToken(): asserts" + terminator + "\n";
      const implementation = "export function payloadToken() { return 42; }\n";
      assert.equal(braceBlockEndLine(overload + implementation, 1, "." + extension, true), 1,
        "an alias named asserts must not absorb its implementation");
    }
  }
});

it("TypeScript next-line typeof return queries retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "typeof-return." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const signature of ["()", "(\n  value = 42,\n)"]) {
        for (const type of ["typeof\n  payloadValue", "typeof\n  /* query target */ payloadValue", "keyof typeof\n  payloadValue"]) {
          const header = "const payloadValue = { value: 42 };" + newline + newline;
          const result = type.startsWith("keyof") ? '"value"' : "payloadValue";
          const declaration = ("export function payloadToken" + signature + ": " + type + "\n{\n  return " + result + ";\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          await f.write(filename, header + declaration + neighbor);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [3, 2 + declaration.trimEnd().split("\n").length]);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), header + replacement + neighbor);
        }
      }

      const overload = ("export function payloadToken(): typeof\n  payloadValue;\n").replaceAll("\n", newline);
      const implementation = ("export function payloadToken() {\n  return payloadValue;\n}\n").replaceAll("\n", newline);
      const { braceBlockEndLine } = await import("../../src/fs/check.js");
      assert.equal(braceBlockEndLine(overload + implementation, 1, "." + extension, true), 2,
        "a completed typeof overload must not absorb the implementation body");
    }
  }
});

it("TypeScript next-line union and intersection operators retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "compound-return." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const signature of ["()", "(\n  value = 42,\n)"]) {
        for (const [type, result] of [
          ["\n  | string\n  | number", "42"],
          ["number\n  /* alternative */ | string", "42"],
          ["{ value: number }\n  & { label: string }", '{ value: 42, label: "value" }'],
          ["\n  & { value: number }\n  // additional member\n  & { label: string }", '{ value: 42, label: "value" }'],
        ]) {
          const declaration = ("export function payloadToken" + signature + ": " + type + "\n{\n  return " + result + ";\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          await f.write(filename, declaration + neighbor);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }

      for (const terminator of ["", ";"]) {
        const overload = ("export function payloadToken():\n  | string\n  | number" + terminator + "\n").replaceAll("\n", newline);
        const implementation = ("export function payloadToken() {\n  return 42;\n}\n").replaceAll("\n", newline);
        const { braceBlockEndLine } = await import("../../src/fs/check.js");
        assert.equal(braceBlockEndLine(overload + implementation, 1, "." + extension, true), 3,
          "a completed compound overload must not absorb its implementation");
      }
    }
  }
});

it("TypeScript multiline delimited return types retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "delimited-return." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const signature of ["()", "(\n  value = 42,\n)"]) {
        for (const [type, result] of [
          ["[\n  number,\n  string\n]", '[42, "value"]'],
          ["Array<\n  number\n>", "[42]"],
          ["(\n  number\n)", "42"],
          ["Array<[\n  number,\n  string\n]>", '[[42, "value"]]'],
        ]) {
          const declaration = ("export function payloadToken" + signature + ": " + type + "\n{\n  return " + result + ";\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          await f.write(filename, declaration + neighbor);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);

          const overload = ("export function payloadToken(): " + type + ";\n").replaceAll("\n", newline);
          const implementation = ("export function payloadToken() {\n  return " + result + ";\n}\n").replaceAll("\n", newline);
          const { braceBlockEndLine } = await import("../../src/fs/check.js");
          assert.equal(braceBlockEndLine(overload + implementation, 1, "." + extension, true), overload.trimEnd().split("\n").length,
            "a completed delimited overload must not absorb the implementation body");
        }
      }
    }
  }
});

it("TypeScript next-line object return types retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "next-line-return." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const signature of ["()", "(\n  value = 42,\n)"]) {
        for (const type of [
          "\n  { value: number }",
          "\n  /* result */ {\n    value: number;\n  }",
          "\n  readonly\n  { value: number }[]",
          " keyof\n  { value: number }",
        ]) {
          const result = type.includes("readonly") ? "[{ value: 42 }]" : type.includes("keyof") ? '"value"' : "{ value: 42 }";
          const declaration = ("export function payloadToken" + signature + ":" + type + "\n{\n  return " + result + ";\n}\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          await f.write(filename, declaration + neighbor);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + declaration);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }

      const overload = ("export function payloadToken():\n  number;\n").replaceAll("\n", newline);
      const implementation = ("export function payloadToken() {\n  return 42;\n}\n").replaceAll("\n", newline);
      const { braceBlockEndLine } = await import("../../src/fs/check.js");
      assert.equal(braceBlockEndLine(overload + implementation, 1, "." + extension, true), 2,
        "a completed overload must not absorb the implementation body");
    }
  }
});

it("TypeScript readonly object-array types retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "readonly-type." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const declarationText of [
        "export function payloadToken(): readonly { value: number }[] {\n  return [{ value: 42 }];\n}\n",
        "export function payloadToken(\n): readonly /* items */ {\n  value: number;\n}[]\n{\n  return [{ value: 42 }];\n}\n",
        "export function payloadToken<T extends readonly {\n  value: number;\n}[]>(value: T): T {\n  return value;\n}\n",
        "export function payloadToken<T = readonly {\n  value: number;\n}[]>(\n  value: T,\n) {\n  return value;\n}\n",
        "export class payloadToken<T extends readonly {\n  value: number;\n}[]> {\n  value: T | undefined;\n}\n",
      ]) {
        const declaration = declarationText.replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export function payloadToken() { return 0; }" + newline;
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found", extension + ": " + declaration + JSON.stringify(view));
        assert.equal(view.text, declaration, extension + ": " + declaration);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      const declaration = ("export class readonly {\n  value = 42;\n}\n").replaceAll("\n", newline);
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      await f.write(filename, declaration + neighbor);
      const named = JSON.stringify({path:filename,query:"readonly",resolve:true});
      const view = (await f.execute("return await read(" + named + ");")).details.result;
      assert.equal(view.text, declaration, "readonly as a class name must not hide its body");
      const replacement = "export class readonly {}" + newline;
      const edited = await f.execute("const v = await read(" + named + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("TypeScript function-type generic parameters retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "function-generic.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const operator of ["extends", "="]) {
      for (const parameters of ["()", "(value: unknown)"]) {
        for (const tail of [
          ">(value: T) {\n  return value;\n}\n",
          ">(\n  value: T,\n) {\n  return value;\n}\n",
          "> {\n  value: T | undefined;\n}\n",
        ]) {
          const kind = tail.startsWith("> {") ? "class" : "function";
          const declaration = ("export " + kind + " payloadToken<T " + operator + " " + parameters + " => /* result */ {\n  alpha: unknown;\n}" + tail).replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const replacement = "export function payloadToken() { return 0; }" + newline;
          const source = declaration + neighbor;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, JSON.stringify({tail,operator,parameters,newline}));
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("function-generic-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("TypeScript keyof generic types retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "keyof-generic.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const operator of ["extends", "="]) {
      for (const tail of [
        ">(value: T) {\n  return value;\n}\n",
        ">(\n  value: T,\n) {\n  return value;\n}\n",
        "> {\n  value: T | undefined;\n}\n",
      ]) {
        const kind = tail.startsWith("> {") ? "class" : "function";
        const declaration = ("export " + kind + " payloadToken<T " + operator + " keyof /* keys */ {\n  alpha: unknown;\n}" + tail).replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export function payloadToken() { return 0; }" + newline;
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, JSON.stringify({tail,operator,newline}));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("keyof-generic-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }

    const declaration = ("export class keyof {\n  value = 42;\n}\n").replaceAll("\n", newline);
    const neighbor = newline + "export function otherToken() { return 99; }" + newline;
    await f.write(filename, declaration + neighbor);
    const named = JSON.stringify({path:filename,query:"keyof",resolve:true});
    const view = (await f.execute("return await read(" + named + ");")).details.result;
    assert.equal(view.text, declaration, "a class named keyof still opens a body");
    const replacement = "export class keyof {}" + newline;
    await f.execute("const v = await read(" + named + "); return await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
  }
});

it("TypeScript generic object defaults retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "generic-default.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const separator of [" ", " /* default */ "]) {
      for (const tail of [
        ">(value?: T) {\n  return value;\n}\n",
        ">(\n  value?: T,\n) {\n  return value;\n}\n",
        "> {\n  value: T | undefined;\n}\n",
      ]) {
        const kind = tail.startsWith("> {") ? "class" : "function";
        const declaration = ("export " + kind + " payloadToken<T =" + separator + "{\n  alpha: unknown;\n}" + tail).replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export function payloadToken() { return 0; }" + newline;
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, JSON.stringify({tail,separator,newline}));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("generic-default-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("TypeScript generic object constraints retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "generic-constraint.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const separator of [" ", " /* constraint */ "]) {
      for (const tail of [
        ">(value: T) {\n  return value.alpha;\n}\n",
        ">(\n  value: T,\n) {\n  return value.alpha;\n}\n",
        "> {\n  value: T | undefined;\n}\n",
      ]) {
        const kind = tail.startsWith("> {") ? "class" : "function";
        const declaration = ("export " + kind + " payloadToken<T extends" + separator + "{\n  alpha: unknown;\n}" + tail).replaceAll("\n", newline);
        const neighbor = "\nexport function otherToken() { return 99; }\n".replaceAll("\n", newline);
        const replacement = "export function payloadToken() { return 0; }\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, JSON.stringify({tail,separator,newline}));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("generic-constraint-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("TypeScript conditional object return types retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "conditional-return.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const parameters of ["()", "(\n  value?: T,\n)"]) {
      for (const separator of [" ", " /* constraint */ "]) {
        const declaration = ("export function payloadToken<T>" + parameters + ": T extends" + separator + "{\n  alpha: unknown;\n} ? 1 : 2 {\n  throw new Error(\"unused\");\n}\n").replaceAll("\n", newline);
        const neighbor = "\nexport function otherToken() { return 99; }\n".replaceAll("\n", newline);
        const replacement = "export function payloadToken() { return 0; }\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, JSON.stringify({parameters,separator,newline}));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("conditional-return-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("TypeScript object type predicates retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "type-predicate.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const parameters of ["(value: unknown)", "(\n  value: unknown,\n)"]) {
      for (const predicate of ["value is", "asserts value is"]) {
        const result = predicate.startsWith("asserts") ? "return;" : "return true;";
        const declaration = ("export function payloadToken" + parameters + ": " + predicate + " {\n  alpha: unknown;\n} {\n  " + result + "\n}\n").replaceAll("\n", newline);
        const neighbor = "\nexport function otherToken() { return 99; }\n".replaceAll("\n", newline);
        const replacement = "export function payloadToken() { return false; }\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, JSON.stringify({parameters,predicate,newline}));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("type-predicate-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }

      for (const returnType of ["is", "typeof is", "keyof (is)"]) {
        const prefix = "type is = { alpha: unknown }; const is = { alpha: 42 };" + newline;
        const result = returnType.startsWith("keyof") ? '"alpha"' : "{ alpha: 42 }";
        const declaration = ("export function payloadToken" + parameters + ": " + returnType + " {\n  return " + result + ";\n}\n").replaceAll("\n", newline);
        const neighbor = newline + "export function otherToken() { return 99; }" + newline;
        const replacement = "export function payloadToken() { return false; }" + newline;
        await f.write(filename, prefix + declaration + neighbor);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.text, declaration, returnType);
        assert.deepEqual(view.lines, [2, 1 + declaration.trimEnd().split("\n").length]);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
      }
    }
  }
});

it("TypeScript keyof object return types retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const filename = "keyof-return.ts";
  const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const parameters of ["()", "(\n  value = 42,\n)"]) {
      const declaration = ("export function payloadToken" + parameters + ": keyof {\n  alpha: unknown;\n} {\n  return \"alpha\";\n}\n").replaceAll("\n", newline);
      const neighbor = "\nexport function otherToken() { return 99; }\n".replaceAll("\n", newline);
      const replacement = "export function payloadToken() { return \"beta\"; }\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, JSON.stringify(parameters + newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("keyof-return-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("arrow expression regexes retain complete editable declaration views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts"]) {
    const filename = "arrow-regex." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return false; }" + newline;

      for (const expression of [
        '() => /[}]/',
        '() => /* arrow payload */ /[}]/',
        '() =>\n    /[}]/',
        '() => { return /[}]/; }',
        '() => 84 / "}/".length',
      ]) {
        for (const declaration of [
          "export function payloadToken() {\n  const probe = " + expression + ";\n  return probe();\n}\n",
          "export function payloadToken(\n  probe = " + expression + ",\n) {\n  return probe();\n}\n",
        ]) {
          const body = declaration.replaceAll("\n", newline);
          const source = body + neighbor;
          const actual = new Function(source.replaceAll("export ", "") + "return payloadToken();")();
          assert.ok(actual === 42 || actual.test("}"));
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, body, extension + ": " + expression);
          assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
          const written = await f.tool.execute("arrow-regex-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("next-line string binding initializers retain complete editable views", async t => {
  const f = await engineFixture(t);

  const initializers = [
    "`alpha\nbeta`",
    "`alpha ${(() => { return `nested ${42}`; })()}\nbeta`",
    '"alpha\\\nbeta"',
    "'alpha\\\nbeta'",
  ];

  for (const extension of ["js", "ts"]) {
    const filename = "next-line-string." + extension;

    for (const newline of ["\n", "\r\n"]) {
      for (const gap of ["\n  ", " // initializer follows\n  /* comment */\n  "]) {
        for (const initializer of initializers) {
          const declaration = ("export const payloadToken =" + gap + initializer + ";\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          assert.equal(new Function(declaration.replaceAll("export ", "") + "return typeof payloadToken;")(), "string");
          await f.write(filename, declaration + neighbor);
          const selector = JSON.stringify({path:filename, query:"payloadToken", resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + initializer);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const replacement = "export const payloadToken = 'replacement';" + newline;
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("next-line function and class binding initializers retain complete editable views", async t => {
  const f = await engineFixture(t);

  const initializers = [
    "function() {\n    return 42;\n  }",
    "function named() {\n    return 42;\n  }",
    "function*() {\n    yield 42;\n  }",
    "async function() {\n    return 42;\n  }",
    "class {\n    method() { return 42; }\n  }",
    "class Named {\n    method() { return 42; }\n  }",
  ];

  for (const extension of ["js", "ts"]) {
    const filename = "next-line-expression." + extension;

    for (const newline of ["\n", "\r\n"]) {
      for (const gap of ["\n  ", " // initializer follows\n  /* comment */\n  "]) {
        for (const initializer of initializers) {
          const declaration = ("export const payloadToken =" + gap + initializer + ";\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          const source = declaration + neighbor;
          assert.equal(new Function(source.replaceAll("export ", "") + "return typeof payloadToken;")(), "function");
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename, query:"payloadToken", resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + initializer);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const replacement = "export const payloadToken = 3;" + newline;
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("TypeScript template interpolations retain assertion dialect in editable declarations", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "template-assertion." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return 3; }" + newline;

      for (const operator of ["as", "satisfies"]) {
        const expression = '84 ' + operator + ' { valueOf(): number } / "}/".length';
        const template = '`${' + expression + '}`';

        for (const operand of [template, '`${' + template + '}`']) {
          for (const declaration of [
            "export function payloadToken() {\n  return " + operand + ";\n}\n",
            "export function payloadToken(\n  value = " + operand + ",\n) {\n  return value;\n}\n",
          ]) {
            const body = declaration.replaceAll("\n", newline);
            const source = body + neighbor;
            await f.write(filename, source);
            const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
            const view = (await f.execute("return await read(" + selector + ");")).details.result;
            assert.equal(view.status, "found");
            assert.equal(view.text, body, extension + ": " + operand);
            assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
            const written = await f.tool.execute("template-assertion-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
            assert.equal(written.isError, undefined);
            assert.doesNotMatch(written.details.result, /check:/);
            const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
            assert.equal(edited.isError, undefined);
            assert.doesNotMatch(edited.details.result, /check:/);
            assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
          }
        }
      }
    }
  }
});

it("nested TypeScript expression scans retain assertion dialect in bodies and signatures", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "nested-assertion." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return 3; }" + newline;

      for (const operator of ["as", "satisfies"]) {
        const expression = '84 ' + operator + ' { valueOf(): number } / "}/".length';

        for (const operand of [
          "function() { return " + expression + "; }",
          'function(\n    value = ' + expression + ',\n  ) { return value; } / "}/".length',
          "class { method() { return " + expression + "; } }",
          "class { method(\n    value = " + expression + ",\n  ) { return value; } }",
        ]) {
          const body = ("export function payloadToken() {\n  const inner = " + operand + ";\n  return 42;\n}\n").replaceAll("\n", newline);
          const source = body + neighbor;
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, body, extension + ": " + operand);
          assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
          const written = await f.tool.execute("nested-assertion-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("TypeScript assertion object types preserve editable declaration boundaries before division", async t => {
  const f = await engineFixture(t);

  for (const extension of ["ts", "tsx"]) {
    const filename = "assertion." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return 3; }" + newline;

      for (const operator of ["as", "satisfies"]) {
        const expression = '84 ' + operator + ' { valueOf(): number } / "}/".length';

        for (const declaration of [
          "export function payloadToken() {\n  return " + expression + ";\n}\n",
          "export function payloadToken(\n  value = " + expression + ",\n) {\n  return value;\n}\n",
        ]) {
          const body = declaration.replaceAll("\n", newline);
          const source = body + neighbor;
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, body, extension + ": " + operator);
          assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
          const written = await f.tool.execute("assertion-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }

  for (const extension of ["js", "ts"]) {
    for (const name of ["as", "satisfies"]) {
      const body = 'export function payloadToken() {\n  const ' + name + '=84;\n  '
        + (extension === "js" ? '84\n  ' + name : 'return ' + name)
        + '\n  { const value = 1; }\n  /}/.test("}");\n  return 42;\n}\n';

      const neighbor = '\nexport function otherToken() { return 99; }\n';
      const filename = "assertion-control." + extension;

      assert.equal(new Function(body.replace("export ", "") + "return payloadToken();")(), extension === "js" ? 42 : 84);
      await f.write(filename, body + neighbor);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, body, extension + ": identifier " + name);
      const replacement = "export function payloadToken() { return 3; }\n";
      await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);

      if (extension === "ts") {
        const loop = 'export function payloadToken() {\n  for (const ' + name
          + ' of { valueOf() { return 0; } } / "}/".length || [42]) { return ' + name + '; }\n  return 0;\n}\n';

        assert.equal(new Function(loop.replace("export ", "") + "return payloadToken();")(), 42);
        await f.write(filename, loop + neighbor);
        const loopView = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(loopView.text, loop, "for-of binding " + name);
        await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("switch case expression operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  const operands = [
    '{ valueOf() { return 84; } }',
    'function() { return 84; }',
    'class { valueOf() { return 84; } }',
    '84',
  ];

  for (const extension of ["js", "ts"]) {
    const filename = "case-expression." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return 3; }" + newline;

      for (const operand of operands) {
        const statement = 'switch (0) {\n    case ' + operand + ' / "}/".length: { return 1; }\n    default: { return 2; }\n  }';

        for (const declaration of [
          "export function payloadToken() {\n  " + statement + "\n}\n",
          "export function payloadToken(\n  value = (() => {\n  " + statement + "\n  })(),\n) {\n  return value;\n}\n",
        ]) {
          const body = declaration.replaceAll("\n", newline);
          const source = body + neighbor;
          assert.equal(new Function(source.replaceAll("export ", "") + "\nreturn payloadToken();")(), 2);
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, body, extension + ": " + operand);
          assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
          const written = await f.tool.execute("case-expression-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("unary-keyword operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  const operands = [
    '{ valueOf() { return 84; } }',
    'function innerValue() { return 84; }',
    'class InnerValue { valueOf() { return 84; } }',
  ];

  for (const extension of ["js", "ts"]) {
    const filename = "unary." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return 2; }" + newline;

      for (const operator of ["typeof", "void", "delete"]) {
        for (const operand of operands) {
          const expression = operator + " " + operand + ' / "}/".length';

          for (const declaration of [
            "export function payloadToken() {\n  return " + expression + ";\n}\n",
            "export function payloadToken(\n  value = " + expression + ",\n) {\n  return value;\n}\n",
          ]) {
            const body = declaration.replaceAll("\n", newline);
            const source = body + neighbor;
            assert.equal(new Function(source.replaceAll("export ", "") + "\nreturn payloadToken();")(), operator === "delete" ? 0.5 : NaN);
            await f.write(filename, source);
            const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
            const view = (await f.execute("return await read(" + selector + ");")).details.result;
            assert.equal(view.status, "found");
            assert.equal(view.text, body, extension + ": " + expression);
            assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
            const written = await f.tool.execute("unary-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
            assert.equal(written.isError, undefined);
            assert.doesNotMatch(written.details.result, /check:/);
            const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
            assert.equal(edited.isError, undefined);
            assert.doesNotMatch(edited.details.result, /check:/);
            assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
          }
        }
      }
    }
  }
});

it("nested constructor expressions in class heritage preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts"]) {
    const filename = "nested-heritage." + extension;

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = newline + "export function otherToken() { return 99; }" + newline;
      const replacement = "export function payloadToken() { return 2; }" + newline;

      for (const base of ["class {}", "class Base {}", "function() {}", "function Base() {}", "class extends class {} {}"]) {
        const expression = "class extends /* base */ " + base + ' {} / "}/".length';

        for (const declaration of [
          "export function payloadToken() {\n  return " + expression + ";\n}\n",
          "export function payloadToken(\n  value = " + expression + ",\n) {\n  return value;\n}\n",
        ]) {
          const body = declaration.replaceAll("\n", newline);
          const source = body + neighbor;
          assert.equal(new Function(source.replaceAll("export ", "") + "\nreturn payloadToken();")(), NaN);
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, body, extension + ": " + expression);
          assert.deepEqual(view.lines, [1, body.trimEnd().split("\n").length]);
          const written = await f.tool.execute("nested-heritage-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("regular-expression class heritage preserves editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "heritage." + extension;

    for (const [declaration, evaluate, expected] of [
      ['export function payloadToken() {\n  class Pattern extends /}/.constructor {}\n  return new Pattern("value").source;\n}\n', 'payloadToken()', "value"],
      ['export function payloadToken(Pattern = class extends /}/.constructor {}) {\n  return new Pattern("value").source;\n}\n', 'payloadToken()', "value"],
      ['export function payloadToken(\n  Pattern = class extends /* base */ /{/.constructor {},\n) {\n  return new Pattern("value").source;\n}\n', 'payloadToken()', "value"],
      ['export class payloadToken extends /{/.constructor {\n  matches(value) { return this.test(value); }\n}\n', 'new payloadToken("value").source', "value"],
      ['export class payloadToken extends /* base */ /}/.constructor {\n  matches(value) { return this.test(value); }\n}\n', 'new payloadToken("value").source', "value"],
      ['export function payloadToken() {\n  const value = { extends: 84 };\n  return value.extends / "}/".length;\n}\n', 'payloadToken()', 42],
    ]) {
      const source = declaration + neighbor;
      assert.equal(new Function(source.replaceAll("export ", "") + "\nreturn " + evaluate + ";")(), expected);
      await f.write(filename, source);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + declaration);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("heritage-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  // Outside JS/TS, extends can be an ordinary operand identifier.
  const cpp = 'double payloadToken(double extends) {\n  return extends / sizeof("}/");\n}\n';
  const written = await f.tool.execute("heritage-identifier-write", {code:'return await write("heritage.cpp",data);',data:cpp}, undefined, undefined, {cwd:f.root});
  assert.equal(written.isError, undefined);
  assert.doesNotMatch(written.details.result, /check:/);
  assert.equal(await fs.readFile(path.join(f.root, "heritage.cpp"), "utf8"), cpp);
});

it("CRLF string continuations preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\r\nexport function otherToken() { return 99; }\r\n";
  const replacement = "export function payloadToken() { return 2; }\r\n";

  for (const quote of ['"', "'"]) {
    const literal = quote + "first\\\r\n}last" + quote;

    for (const declaration of [
      "export function payloadToken() {\r\n  const value = " + literal + ";\r\n  return value;\r\n}\r\n",
      "export function payloadToken(value = " + literal + ") {\r\n  return value;\r\n}\r\n",
      "export function payloadToken(\r\n  value = " + literal + ",\r\n) {\r\n  return value;\r\n}\r\n",
    ]) {
      assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), "first}last");
      await f.write("continuation.js", declaration + neighbor);
      const view = (await f.execute('return await read({query:"payloadToken",resolve:true});')).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const receipt = await f.tool.execute("continuation-write", {code:'return await write("continuation.js",data);',data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
      assert.equal(receipt.isError, undefined);
      assert.doesNotMatch(receipt.details.result, /check:/);
      const edited = await f.tool.execute("continuation-edit", {code:'const v = await read({query:"payloadToken",resolve:true}); return await edit(v,data);',data:replacement}, undefined, undefined, {cwd:f.root});
      assert.equal(edited.isError, undefined);
      assert.equal(await fs.readFile(path.join(f.root, "continuation.js"), "utf8"), replacement + neighbor);
    }

    // Single-character line terminators must not consume the following quote.
    for (const newline of ["\n", "\r"]) {
      const declaration = "export function payloadToken() {\n  return " + quote + "first\\" + newline + quote + ";\n}\n";
      assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), "first");
      await f.write("continuation.js", declaration + neighbor);
      const view = (await f.execute('return await read({query:"payloadToken",resolve:true});')).details.result;
      assert.equal(view.text, declaration);
      const receipt = await f.tool.execute("single-terminator-write", {code:'return await write("continuation.js",data);',data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
      assert.doesNotMatch(receipt.details.result, /check:/);
    }
  }
});

it("JavaScript private identifiers preserve editable method boundaries", async t => {
  const f = await engineFixture(t);
  const replacement = "  payloadToken() { return 2; }\n";
  const neighbor = "\n  otherToken() { return 99; }\n}\n\nexport function outsideToken() { return 100; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "private-names." + extension;

    for (const [field, params, statement] of [
      ["#return = 84;", "", 'return this.#return / "}/".length;'],
      ["#throw = 84;", "", 'return this.#throw / "}/".length;'],
      ["#return = 84;", 'value = this.#return / "}/".length', "return value;"],
      ["#if() { return 84; }", "", 'return this.#if() / "}/".length;'],
      ["#πreturn = 84;", "", 'return this.#πreturn / "}/".length;'],
      ["return = 84;", "", 'return this.return / "}/".length;'],
    ]) {
      const prefix = "export class Host {\n  " + field + "\n";
      const declaration = "  payloadToken(" + params + ") {\n    " + statement + "\n  }\n";
      const source = prefix + declaration + neighbor;
      assert.equal(new Function(source.replaceAll("export ", "") + "\nreturn new Host().payloadToken();")(), 42);
      await f.write(filename, source);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + field + ": " + params);
      assert.deepEqual(view.lines, [3, 5]);
      const written = await f.tool.execute("private-names-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
    }
  }
});

it("JavaScript line-comment terminators preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "comment-end." + extension;

    for (const terminator of ["\r", "\u2028", "\u2029", "\n", "\r\n"]) {
      for (const declaration of [
        "export function payloadToken() {\n  // note" + terminator + "  return 59; }\n",
        "export function payloadToken(value // note" + terminator + ") {\n  return 59;\n}\n",
        "export function payloadToken(\n  value // note" + terminator + ") {\n  return 59;\n}\n",
        'export function payloadToken() {\n  /* note' + terminator + ' } " [ */\n  return 59;\n}\n',
      ]) {
        assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 59);
        await f.write(filename, declaration + neighbor);
        const view = (await f.execute('return await read(' + JSON.stringify({path:filename,query:"payloadToken",resolve:true}) + ');')).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + JSON.stringify(terminator));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const receipt = await f.tool.execute("comment-end-write", {code:'return await write(data.path,data.source);',data:{path:filename,source:declaration + neighbor}}, undefined, undefined, {cwd:f.root});
        assert.doesNotMatch(receipt.details.result, /check:/);
        const edited = await f.execute('const v = await read(' + JSON.stringify({path:filename,query:"payloadToken",resolve:true}) + '); return await edit(v,' + JSON.stringify(replacement) + ');');
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  // Unicode separators are payload in Rust line comments, not ECMAScript terminators.
  for (const separator of ["\u2028", "\u2029"]) {
    const declaration = 'fn payloadToken() {\n    // note' + separator + ' } " [\n}\n';
    const rustNeighbor = "\nfn otherToken() {}\n";
    await f.write("comment-end.rs", declaration + rustNeighbor);
    const view = (await f.execute('return await read({path:"comment-end.rs",query:"payloadToken",resolve:true});')).details.result;
    assert.equal(view.text, declaration);
    const receipt = await f.tool.execute("comment-end-rust-write", {code:'return await write("comment-end.rs",data);',data:declaration + rustNeighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    await f.execute('const v = await read({path:"comment-end.rs",query:"payloadToken",resolve:true}); await edit(v,"fn payloadToken() {}\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "comment-end.rs"), "utf8"), "fn payloadToken() {}\n" + rustNeighbor);
  }
});

it("JavaScript of identifiers preserve editable declaration boundaries without losing for-of regex operands", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "contextual-of." + extension;

    for (const [params, statement, expected] of [
      ['value', 'const of = 84; return of / "}/".length;', 42],
      ['of = 84', 'return of / "}/".length;', 42],
      ['of = 84', 'return of /* divisor */ / "}/".length;', 42],
      ['of = 84', '84\n  of / "}/".length; return 42;', 42],
      ['of = 84', 'of\n  { label: 1; } /}/.test("}"); return 42;', 42],
      ['of = 84, value = of / "}/".length', 'return value;', 42],
      ['\n  of = 84,\n  value = of / "}/".length,\n  unused\n', 'return value;', 42],
      ['of = 84', 'for (; of / "}/".length < 1;) {} return 42;', 42],
      ['of = 84', 'for (const value of /}/.source) { if (value === "}") return 42; }', 42],
      ['of = 84', 'for (const of of /}/.source) { if (of === "}") return 42; }', 42],
      ['of = 84', 'for (const {length} of /}/.source) { return length * 42; }', 42],
      ['of = 84', 'for (const value of { [Symbol.iterator]: function*() { yield 42; } } / "}/".length || [42]) { return value; }', 42],
      ['of = 84', 'return (async () => { for await (const of of /}/.source) { if (of === "}") return 42; } })();', 42],
      ['value = (() => { for (const x of /\\(/.source) { return 42; } })()', 'return value;', 42],
      ['\n  value = (() => { for (const x of /\\(/.source) { return 42; } })(),\n', 'return value;', 42],
      ['value = {of:84}', 'return value.of / "}/".length;', 42],
    ]) {
      const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
      const source = declaration + neighbor;
      assert.equal(await new Function(source.replaceAll("export ", "") + "\nreturn payloadToken();")(), expected);
      await f.write(filename, source);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + params + ": " + statement);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("contextual-of-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }

    const binding = 'export const payloadToken = (() => { for (const x of /\\(/.source) { return 42; } })\n';
    const tail = "{\n  const unrelatedSentinel = 99;\n}\n" + neighbor;
    const bindingReplacement = "export const payloadToken = () => 2;\n";
    assert.equal(new Function((binding + tail).replaceAll("export ", "") + "\nreturn payloadToken();")(), 42);
    await f.write(filename, binding + tail);
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, binding);
    assert.deepEqual(view.lines, [1, 1]);
    await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(bindingReplacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), bindingReplacement + tail);
  }
});

it("a thrown regex cannot truncate a resolved declaration or leave its closing brace after replacement", async t => {
  const f = await engineFixture(t);
  const declaration = "export function payloadToken() {\n  throw /}/;\n}\n";
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  await f.write("throw-regex.js", declaration + neighbor);
  const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.text, declaration);
  assert.deepEqual(view.lines, [1, 3]);
  await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export function payloadToken() { return 2; }\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "throw-regex.js"), "utf8"), "export function payloadToken() { return 2; }\n" + neighbor);
});

it("regex division operands preserve complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return 42 / /}/.test("}");'],
    ['value', 'return 42 / /* denominator */ /}/.test("}");'],
    ['value = 42 / /{/.test("{")', 'return value;'],
    ['value = 42 / /{/.test("{"),\n  unused\n', 'return value;'],
    ['value', 'return 168 / 2 / ("}/".length);'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
    await f.write("division-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, params + ": " + statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("division-regex-write", {code:'return await write("division-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.doesNotMatch(edited.details.result, /check:/);
    assert.equal(await fs.readFile(path.join(f.root, "division-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("escaped identifiers preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "escaped-identifiers." + extension;

    for (const identifier of [String.raw`\u{61}return`, String.raw`a\u{61}throw`, String.raw`function\u{61}`, String.raw`\u0061return`, String.raw`a\u0061throw`, String.raw`function\u0061`]) {
      for (const [params, statement] of [
        ["", "const " + identifier + " = 84;\n  return " + identifier + ' / "}/".length;'],
        [identifier + " = 84, value = " + identifier + ' / "}/".length', "return value;"],
        ["\n  " + identifier + " = 84,\n  value = " + identifier + ' / "}/".length,\n  unused\n', "return value;"],
      ]) {
        const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
        assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
        await f.write(filename, declaration + neighbor);
        const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
        const resolved = await f.execute("return await read(" + selector + ");");
        assert.equal(resolved.isError, undefined);
        const view = resolved.details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + identifier + ": " + params);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("escaped-identifier-write", {code:"return await write(data.path,data.source);",data:{path:filename,source:declaration + neighbor}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }

    // Escaped names must not become control-condition keywords either.
    const declaration = String.raw`export function payloadToken(\u{61}if = () => 84) {
  return \u{61}if() / "}/".length;
}
`;

    assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
    await f.write(filename, declaration + neighbor);
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, declaration);
    await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
  }
});

it("Unicode identifiers keep keyword suffixes out of editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "unicode-identifiers." + extension;

    for (const [params, statement] of [
      ['πreturn = 84', 'return πreturn / ("}/".length);'],
      ['a\u0301throw = 84', 'return a\u0301throw / ("}/".length);'],
      ['𐐀return = 84', 'return 𐐀return / ("}/".length);'],
      ['a\u200Creturn = 84', 'return a\u200Creturn / ("}/".length);'],
      ['a\u200Dreturn = 84', 'return a\u200Dreturn / ("}/".length);'],
      ['πif = () => 84', 'return πif() / ("}/".length);'],
      ['value = {πthrow:84}', 'return value.πthrow / ("}/".length);'],
      ['πreturn = 84, value = πreturn / ("}/".length)', 'return value;'],
      ['πreturn = 84,\n  value = πreturn / ("}/".length),\n  unused\n', 'return value;'],
      ['value = 84', 'if (value) /}/.test("}"); return value / ("}/".length);'],
    ]) {
      const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
      assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
      await f.write(filename, declaration + neighbor);
      const args = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute('return await read(' + args + ');')).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + params + ": " + statement);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const receipt = await f.tool.execute("unicode-identifier-write", {code:'return await write(data.path,data.source);',data:{path:filename,source:declaration + neighbor}}, undefined, undefined, {cwd:f.root});
      assert.doesNotMatch(receipt.details.result, /check:/);
      const edited = await f.execute('const v = await read(' + args + '); return await edit(v,' + JSON.stringify(replacement) + ');');
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("spread operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "spread-operands." + extension;

    for (const [params, statement, expected] of [
      ['value', 'return [.../}/.source].join("");', "}"],
      ['value', 'return String(.../}/.source);', "}"],
      ['value', 'return ({.../}/.source})[0];', "}"],
      ['value', 'return [... /* operand */ /}/.source].join("");', "}"],
      ['value = [.../{/.source].join("")', 'return value;', "{"],
      ['value = [.../{/.source].join(""),\n  unused\n', 'return value;', "{"],
      ['value', 'return [...{} / "}/".length || "x"].join("");', "x"],
      ['value', 'return (2.).valueOf() / "}/".length;', 1],
    ]) {
      const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
      assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), expected);
      await f.write(filename, declaration + neighbor);
      const args = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute('return await read(' + args + ');')).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + params + ": " + statement);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const receipt = await f.tool.execute("spread-operand-write", {code:'return await write(data.path,data.source);',data:{path:filename,source:declaration + neighbor}}, undefined, undefined, {cwd:f.root});
      assert.doesNotMatch(receipt.details.result, /check:/);
      const edited = await f.execute('const v = await read(' + args + '); return await edit(v,' + JSON.stringify(replacement) + ');');
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("regex statements after control conditions keep the enclosing view intact", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";

  for (const statement of [
    'if (value) /}/.test(value);',
    'while (value) /}/.test(value);',
    'for (; value; value = false) /}/.test(value);',
    'if (Boolean(value)) /* body */ /}/.test(value);',
    'if ((value) / (Boolean(value) ? 2 : 3)) /}/.test(value);',
    'with (value) /}/.test(value);',
  ]) {
    const declaration = "export function payloadToken(value) {\n  " + statement + "\n  return value;\n}\n";
    await f.write("control-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 4]);
    const receipt = await f.tool.execute("control-regex-write", {code:'return await write("control-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "control-regex.js"), "utf8"), "export function payloadToken() { return 2; }\n" + neighbor);
  }
});

it("for-await regex loop bodies retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export async function payloadToken() { return 2; }\n";

  for (const statement of [
    'for await (const value of values) /}/.test(value);',
    'for /* async loop */ await (const value of values) /}/.test(value);',
    'const ratio = await (values) / ("}/".length);',
  ]) {
    const declaration = "export async function payloadToken(values) {\n  " + statement + "\n  return values;\n}\n";
    // Establish valid JavaScript independently of the structural scanner.
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("for-await.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 4]);
    const receipt = await f.tool.execute("for-await-write", {code:'return await write("for-await.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export async function payloadToken() { return 2; }\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "for-await.js"), "utf8"), replacement + neighbor);
  }
});

it("regex statements after semicolon-free debugger statements preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const statement of [
    'debugger\n  /}/.test(value);',
    'debugger /*\n    pause here\n  */ /[{}()]/.test(value);',
    'debugger; /}/.test(value);',
    'return value.debugger / ("}/".length);',
  ]) {
    const declaration = "export function payloadToken(value) {\n  " + statement + "\n  return value;\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("debugger-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("debugger-regex-write", {code:'return await write("debugger-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "debugger-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("regex statements after semicolon-free break and continue preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const statement of [
    'while (value) { break\n    /}/.test(value);\n  }',
    'while (value) { continue\n    /}/.test(value);\n  }',
    'outer: while (value) { break outer\n    /}/.test(value);\n  }',
    'outer: while (value) { continue outer\n    /}/.test(value);\n  }',
    'while (value) { break /*\n    end statement\n  */ /}/.test(value);\n  }',
    'outer: while (value) { continue /* target */ outer /*\n    end statement\n  */ /}/.test(value);\n  }',
    'return value.break / ("}/".length);',
    'return value.continue / ("}/".length);',
  ]) {
    const declaration = "export function payloadToken(value) {\n  " + statement + "\n  return value;\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("jump-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("jump-regex-write", {code:'return await write("jump-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "jump-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("awaited regex operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export async function payloadToken() { return 2; }\n";

  for (const statement of [
    'return await /}/;',
    'return await /* operand */ /[{}()]/;',
    'return value.await / ("}/".length);',
  ]) {
    const declaration = "export async function payloadToken(value) {\n  " + statement + "\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("await-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, statement);
    assert.deepEqual(view.lines, [1, 3]);
    const receipt = await f.tool.execute("await-regex-write", {code:'return await write("await-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export async function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "await-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("yielded regex operands preserve editable generator declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function* payloadToken() { yield 2; }\n";

  for (const statement of [
    'yield /}/;',
    'yield /* operand */ /[{}()]/;',
    'yield* /}/.source;',
    'yield value.yield / ("}/".length);',
  ]) {
    const declaration = "export function* payloadToken(value) {\n  " + statement + "\n  return value;\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("yield-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, statement);
    assert.deepEqual(view.lines, [1, 4]);
    const receipt = await f.tool.execute("yield-regex-write", {code:'return await write("yield-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function* payloadToken() { yield 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "yield-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("regex constructor operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return new /}/.constructor("value");'],
    ['value', 'return new /* constructor */ /}/.constructor("value");'],
    ['value = new /}/.constructor("value")', 'return value;'],
    ['value = new /}/.constructor("value"),\n  unused\n', 'return value;'],
    ['value', 'return value.new / ("}/".length);'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("new-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, params + ": " + statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("new-regex-write", {code:'return await write("new-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "new-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("unary-keyword regex operands retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return void /}/;'],
    ['value', 'return delete /}/.source;'],
    ['value', 'return value.void / ("}/".length);'],
    ['value', 'return value.delete / ("}/".length);'],
    ['value = defaults.void / ("}/".length)', 'return value;'],
    ['value = defaults.delete / ("}/".length),\n  unused\n', 'return value;'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("unary-regex.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("unary-regex-write", {code:'return await write("unary-regex.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "unary-regex.js"), "utf8"), replacement + neighbor);
  }
});

it("instanceof regex operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return value instanceof /}/.constructor;'],
    ['value', 'return value instanceof /* constructor */ /}/.constructor;'],
    ['value = input instanceof /}/.constructor', 'return value;'],
    ['value = input instanceof /[{}()]/.constructor,\n  unused\n', 'return value;'],
    ['value', 'return value.instanceof / ("}/".length);'],
    ['value = defaults.instanceof / ("}/".length)', 'return value;'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("instanceof.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, params + ": " + statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("instanceof-write", {code:'return await write("instanceof.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "instanceof.js"), "utf8"), replacement + neighbor);
  }
});

it("function and class expression division preserves editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["js", "ts"]) {
    const filename = "expression-division." + extension;

    for (const [params, statement, expected] of [
      ['value', 'return function() { return 84; } / ("}/".length);', NaN],
      ['value', 'return function named() { return 84; } / ("}/".length);', NaN],
      ['value', 'return function*() { yield 84; } / ("}/".length);', NaN],
      ['value', 'return async function() { return 84; } / ("}/".length);', NaN],
      ['value', 'return async /* callable */ function() { return 84; } / ("}/".length);', NaN],
      ['value', 'const amount = function() {} / ("}/".length); return amount;', NaN],
      ['value = function() {} / ("}/".length)', 'return value;', NaN],
      ['value = function() {} / ("}/".length),\n  unused\n', 'return value;', NaN],
      ['value', 'return class { static valueOf() { return 84; } } / ("}/".length);', 42],
      ['value', 'return class Named { static valueOf() { return 84; } } / ("}/".length);', 42],
      ['value', 'return class extends /}/.constructor {} / ("}/".length);', NaN],
      ['value = class {} / ("}/".length),\n  unused\n', 'return value;', NaN],
      ['value', 'function inner() { return 84; } /}/.test("}"); return 42;', 42],
      ['value', 'class Pattern {} /}/.test("}"); return 42;', 42],
      ['value = {function:84,class:84}', 'return value.function / ("}/".length);', 42],
      ['value', 'const async = 84; async\n  function inner() {}\n  /}/.test("}"); return async / ("}/".length);', 42],
    ]) {
      const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
      const source = declaration + neighbor;
      assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), expected);
      await f.write(filename, source);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + params + ": " + statement);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("expression-division-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("new constructor expressions preserve editable declaration boundaries before division", async t => {
  const f = await engineFixture(t);

  const constructors = [
    'class { valueOf() { return 84; } }',
    'class Amount { valueOf() { return 84; } }',
    'function() { this.valueOf = () => 84; }',
    'function Amount() { this.valueOf = () => 84; }',
  ];

  for (const extension of ["js", "ts"]) {
    const filename = "constructor-expression." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = "\nexport function otherToken() { return 99; }\n".replaceAll("\n", newline);
      const replacement = "export function payloadToken() { return 2; }\n".replaceAll("\n", newline);

      for (const constructor of constructors) {
        for (const wrapped of [false, true]) {
          const expression = 'new /* constructor */ ' + constructor + ' / ("}/".length)';

          const declaration = (wrapped
            ? "export function payloadToken(\n  value = " + expression + "\n) {\n  return value;\n}\n"
            : "export function payloadToken() {\n  return " + expression + ";\n}\n").replaceAll("\n", newline);

          const source = declaration + neighbor;
          assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + constructor + ": wrapped=" + wrapped);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("constructor-expression-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.doesNotMatch(written.details.result, /check:/);
          await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("comparison and shift operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  const operands = [
    '{ valueOf() { return 84; } }',
    'function() { return 84; }',
    'class { static valueOf() { return 84; } }',
  ];

  for (const extension of ["js", "ts"]) {
    const filename = "comparison." + extension;

    for (const operator of ["<", ">", "<<", ">>", "<=", ">="]) {
      for (const operand of operands) {
        for (const wrapped of [false, true]) {
          const expression = '100 ' + operator + ' ' + operand + ' / ("}/".length)';

          const declaration = wrapped
            ? "export function payloadToken(\n  value = " + expression + "\n) {\n  return value;\n}\n"
            : "export function payloadToken() {\n  return " + expression + ";\n}\n";

          const source = declaration + neighbor;
          // All fixtures are executable JavaScript, not merely balanced text.
          new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")();
          await f.write(filename, source);
          const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + expression + ": wrapped=" + wrapped);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("comparison-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.doesNotMatch(written.details.result, /check:/);
          await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }

  for (const [extension, prefix, declaration, replacement] of [
    ["ts", "", "export function PayloadToken(\n): Promise<number> {\n  return Promise.resolve(42);\n}\n", "export function PayloadToken(): Promise<number> { return Promise.resolve(42); }\n"],
    ["rs", "", "pub struct PayloadToken<T> {\n  pub value: T,\n}\n", "pub struct PayloadToken<T> { pub value: T }\n"],
    ["cpp", "template <typename T> class Base {};\n", "class PayloadToken : public Base<decltype(\n  0\n)> {\npublic:\n  int value = 42;\n};\n", "class PayloadToken : public Base<int> {};\n"],
  ]) {
    const filename = "PayloadToken." + extension;
    const neighbor = "\n// untouched neighbor\n";
    await f.write(filename, prefix + declaration + neighbor);
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, declaration, extension + " generic declaration");
    await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
  }
});

it("object-literal division preserves editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return { valueOf: () => 84 } / ("}/".length);'],
    ['value', 'const amount = { valueOf: () => 84 } / ("}/".length); return amount;'],
    ['value = { valueOf: () => 84 } / ("}/".length)', 'return value;'],
    ['value = { valueOf: () => 84 } / ("}/".length),\n  unused\n', 'return value;'],
    ['value', 'return { valueOf() { return 84; } } / ("}/".length);'],
    ['value', 'return /* operand */ { valueOf: () => 84 } / ("}/".length);'],
    ['value', 'return ({ valueOf: () => 84 }) / ("}/".length);'],
    ['value', 'return 168 / { valueOf() { return 2; } } / ("}/".length);'],
    ['value', 'return 168 / /* denominator */ { valueOf: () => 2 } / ("}/".length);'],
    ['value = 168 / { valueOf: () => 2 } / ("}/".length)', 'return value;'],
    ['value = 168 / { valueOf: () => 2 } / ("}/".length),\n  unused\n', 'return value;'],
    ['value', 'if (value) {} /}/.test(String(value)); return 42;'],
    ['value', 'function inner() { return\n    { value: 42; } /}/.test("}"); }\n  inner(); return 42;'],
    ['value', 'function inner() { return /*\n*/ { value: 42; } /}/.test("}"); }\n  inner(); return 42;'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
    await f.write("object-division.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, params + ": " + statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("object-division-write", {code:'return await write("object-division.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.equal(await fs.readFile(path.join(f.root, "object-division.js"), "utf8"), replacement + neighbor);
  }
});

it("colon expression operands preserve editable declaration boundaries without recasting labels", async t => {
  const f = await engineFixture(t);
  const cases = [];

  for (const expression of [
    '({ amount: { valueOf() { return 84; } } / ("}/".length) }).amount',
    '({ outer: { amount: /* operand */ { valueOf() { return 84; } } / ("}/".length) } }).outer.amount',
    'false ? 0 : { valueOf() { return 84; } } / ("}/".length)',
    'true ? false ? 0 : { valueOf() { return 84; } } / ("}/".length) : 0',
  ]) {
    cases.push(['value', 'return ' + expression + ';']);
    cases.push(['value = ' + expression, 'return value;']);
    cases.push(['value = ' + expression + ',\n  unused\n', 'return value;']);
  }

  cases.push(
    ['value', 'const options = { amount: function () {} / ("}/".length) }; return Number.isNaN(options.amount) ? 42 : 0;'],
    ['value', 'const options = { amount: class {} / ("}/".length) }; return Number.isNaN(options.amount) ? 42 : 0;'],
    ['value', 'const amount = false ? 0 : function () {} / ("}/".length); return Number.isNaN(amount) ? 42 : 0;'],
    ['value', 'true ? (() => { label: {} /}/.test("}"); return 42; })() : 0;\n  return 42;'],
    ['value', 'label: { break label; } /}/.test("}");\n  return 42;'],
    ['value', 'switch (42) { case 42: {} /}/.test("}"); break; default: {} }\n  return 42;'],
    ['value', 'const amount = value ?? { answer: 42 }; label: {} /}/.test("}");\n  return amount.answer;'],
    ['value', 'value?.answer; label: {} /}/.test("}");\n  return 42;'],
  );

  for (const extension of ["js", "ts"]) {
    const filename = "colon-expression." + extension;
    const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      const neighbor = "\nexport function otherToken() { return 99; }\n".replaceAll("\n", newline);
      const replacement = "export function payloadToken() { return 2; }\n".replaceAll("\n", newline);

      for (const [params, statement] of cases) {
        const declaration = ("export function payloadToken(" + params + ") {\n  " + statement + "\n}\n").replaceAll("\n", newline);
        const source = declaration + neighbor;
        assert.equal(new Function(declaration.replace(/^export /, "") + "\nreturn payloadToken();")(), 42);
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, params + ": " + statement + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("colon-expression-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("prefix update regex operands preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return ++ /}/.lastIndex;'],
    ['value', 'return -- /* operand */ /}/.lastIndex;'],
    ['value', '++ /}/.lastIndex; return 1;'],
    ['value', 'if (value) ++ /}/.lastIndex; return 1;'],
    ['value = ++ /}/.lastIndex', 'return value;'],
    ['value = -- /}/.lastIndex,\n  unused\n', 'return value;'],
    ['value', 'value\n  ++ /}/.lastIndex; return 1;'],
    ['value', 'value /*\n    new statement\n  */ -- /}/.lastIndex; return -1;'],
    ['value', 'return value /* postfix */ ++ / ("}/".length);'],
    ['value', 'return value /* postfix */ -- / ("}/".length);'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("prefix-update.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, params + ": " + statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("prefix-update-write", {code:'return await write("prefix-update.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(edited.isError, undefined);
    assert.doesNotMatch(edited.details.result, /check:/);
    assert.equal(await fs.readFile(path.join(f.root, "prefix-update.js"), "utf8"), replacement + neighbor);
  }

  // Unlike JavaScript, these languages permit a postfix update after a newline.
  for (const [file, source] of [
    ['postfix.java', 'class Payload {\n  int payloadToken(int value) {\n    return value\n      ++ / "}/".length();\n  }\n}\n'],
    ['postfix.cpp', 'int payloadToken(int value) {\n  return value\n    -- / sizeof("}/");\n}\n'],
  ]) {
    const receipt = await f.tool.execute("postfix-newline-write", {code:'return await write(data.path,data.source);', data:{path:file,source}}, undefined, undefined, {cwd:f.root});
    assert.equal(receipt.isError, undefined);
    assert.doesNotMatch(receipt.details.result, /check:/, file);
    assert.equal(await fs.readFile(path.join(f.root, file), "utf8"), source);
  }
});

it("postfix arithmetic division preserves editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const [params, statement] of [
    ['value', 'return value++ / ("}/".length);'],
    ['value', 'return value-- / ("}/".length);'],
    ['value = count++ / ("}/".length)', 'return value;'],
    ['value = count-- / ("}/".length),\n  unused\n', 'return value;'],
    ['value', 'return + + /}/.source;'],
    ['value', 'return - - /}/.source;'],
  ]) {
    const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
    assert.doesNotThrow(() => new Function(declaration.replace(/^export /, "")));
    await f.write("postfix.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, params + ": " + statement);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    const receipt = await f.tool.execute("postfix-write", {code:'return await write("postfix.js",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "postfix.js"), "utf8"), replacement + neighbor);
  }
});

it("a Python declaration span includes a wrapped signature and body", async t => {
  const f = await engineFixture(t);
  await f.write("nest.py", `def payloadToken(
    selector,
):
    return selector

def otherToken():
    return 1
`);
  const source = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "nest.py");
  assert.match(source.text, /^def payloadToken/);
  assert.match(source.text, /return selector/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 4]);
});

it("mixed-case Python extensions retain complete editable declaration views", async t => {
  const f = await engineFixture(t);
  const declaration = "def payloadToken():\n    value = 42\n    return value\n";
  const neighbor = "\ndef otherToken():\n    return 99\n";
  const replacement = "def payloadToken(): return 2\n";

  for (const extension of ["py", "PY", "pY"]) {
    const filename = "case." + extension;
    await f.write(filename, declaration + neighbor);
    const source = (await f.execute('return await read(' + JSON.stringify({path:filename,query:"payloadToken",resolve:true}) + ');')).details.result;
    assert.equal(source.status, "found");
    assert.equal(source.path, filename);
    assert.equal(source.text, declaration, filename);
    assert.deepEqual(source.lines, [1, 3]);
    const focused = await f.execute('return await read(' + JSON.stringify(filename) + ',{about:"payloadToken"});');
    assert.match(focused.details.result, /return value/);
    await f.execute('const v = await read(' + JSON.stringify({path:filename,query:"payloadToken",resolve:true}) + '); await edit(v,' + JSON.stringify(replacement) + ');');
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
  }
});

it("unindented Python comments do not truncate declaration views or replacements", async t => {
  const f = await engineFixture(t);
  const declaration = "def payloadToken():\n    value = 42\n# A comment has no suite indentation.\n    return value\n";
  const neighbor = "\n# This comment belongs to the neighbor.\n\ndef otherToken():\n    return 99\n";
  await f.write("comments.py", declaration + neighbor);
  const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.text, declaration);
  assert.deepEqual(view.lines, [1, 4]);
  await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"def payloadToken(): return 2\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "comments.py"), "utf8"), "def payloadToken(): return 2\n" + neighbor);
});

it("a Python wrapped signature is not closed by a comment colon", async t => {
  const f = await engineFixture(t);
  await f.write("nest.py", `def payloadToken(
    selector,  # note:
):
    return selector

def otherToken():
    return 1
`);
  const source = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "nest.py");
  assert.match(source.text, /^def payloadToken/);
  assert.match(source.text, /return selector/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 4]);
});

it("Python inline suites resolve and replace only their own declaration", async t => {
  const f = await engineFixture(t);
  const neighbor = "\ndef otherToken():\n    return 99\n";

  for (const declaration of [
    'def payloadToken(value: dict[str, int] = {"key": 1}): return value["key"]\n',
    'def payloadToken(\n    value: dict[str, int] = {"key": 1},\n): return value["key"]\n',
  ]) {
    await f.write("inline.py", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    assert.equal(view.text, declaration);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"def payloadToken(): return 2\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "inline.py"), "utf8"), "def payloadToken(): return 2\n" + neighbor);
  }
});

it("Python constant views replace only their assignment, not later declarations", async t => {
  const f = await engineFixture(t);
  const neighbor = "\ndef otherToken():\n    return 99\n";

  for (const assignment of [
    "MAX_COUNT = 10\n",
    "MAX_COUNT: int = 10\n",
    'MAX_COUNT = {\n    "value": 10,\n}\n',
    "MAX_COUNT = 1 + \\\n    9\n",
  ]) {
    await f.write("constants.py", assignment + neighbor);
    const view = (await f.execute('return await read({query:"MAX_COUNT", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, assignment);
    assert.deepEqual(view.lines, [1, assignment.trimEnd().split("\n").length]);
    await f.execute('const v = await read({query:"MAX_COUNT", resolve:true}); await edit(v,"MAX_COUNT = 2\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "constants.py"), "utf8"), "MAX_COUNT = 2\n" + neighbor);
  }
});

it("Python triple-quoted constants retain embedded quotes and comments during replacement", async t => {
  const f = await engineFixture(t);
  const neighbor = "\ndef otherToken():\n    return 99\n";

  for (const quote of ['"""', "'''"]) {
    const declaration = "PAYLOAD_TOKEN = " + quote + "first\nquote: " + quote[0] + " and # literal\nlast\n" + quote + "\n";
    await f.write("triple.py", declaration + neighbor);
    const view = (await f.execute('return await read({query:"PAYLOAD_TOKEN", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 4]);
    await f.execute('const v = await read({query:"PAYLOAD_TOKEN", resolve:true}); await edit(v,"PAYLOAD_TOKEN = 2\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "triple.py"), "utf8"), "PAYLOAD_TOKEN = 2\n" + neighbor);
  }
});

it("Python suite views retain dedented multiline string contents and replace the whole body", async t => {
  const f = await engineFixture(t);
  const neighbor = "\ndef otherToken():\n    return 99\n";

  for (const quote of ['"""', "'''"]) {
    const declaration = "def payloadToken():\n    text = " + quote + "first\ndedented # literal\n" + quote + "\n    return text\n";
    await f.write("suite.py", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 5]);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"def payloadToken(): return 2\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "suite.py"), "utf8"), "def payloadToken(): return 2\n" + neighbor);
  }
});

it("a Rust declaration span does not swallow later fns because of a lifetime", async t => {
  const f = await engineFixture(t);
  await f.write("nest.rs", `fn payloadToken() {
    let x: &'static str = "ok";
    x
}

fn otherToken() {
    1
}
`);
  const source = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "nest.rs");
  assert.match(source.text, /^fn payloadToken/);
  assert.match(source.text, /&'static str/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 4]);
});

it("a Rust declaration span does not swallow later fns because of a raw string", async t => {
  const f = await engineFixture(t);
  await f.write("nest.rs", `fn payloadToken() {
    let x = r#"
}
"#;
    x
}

fn otherToken() {
    1
}
`);
  const source = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "nest.rs");
  assert.match(source.text, /^fn payloadToken/);
  assert.match(source.text, /let x = r#"/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 6]);
});

it("Rust raw identifiers preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "raw-identifiers.rs";
  const neighbor = "\npub fn other_token() -> usize { 99 }\n";
  const replacement = "pub fn payload_token() -> usize { 2 }\n";
  const selector = JSON.stringify({path:filename,query:"payload_token",resolve:true});

  for (const [prefix, declaration] of [
    ["", 'pub fn payload_token() -> usize {\n    let r#return = 84;\n    r#return / "}/".len()\n}\n'],
    ["", 'pub fn payload_token() -> usize {\n    let r#break = 84;\n    r#break /* divisor */ / "}/".len()\n}\n'],
    ["", 'pub fn payload_token() -> usize {\n    let r#if = || 84;\n    r#if() / "}/".len()\n}\n'],
    ['const r#return: usize = 84;\n\n', 'pub fn payload_token(value: [u8; r#return / "}/".len()]) -> usize {\n    value.len()\n}\n'],
    ['const r#return: usize = 84;\n\n', 'pub fn payload_token(\n    value: [u8; r#return / "}/".len()],\n) -> usize {\n    value.len()\n}\n'],
    ["", 'pub fn payload_token() -> usize {\n    let r = 84;\n    r / "}/".len()\n}\n'],
    ["", 'pub fn payload_token() -> usize {\n    let r#return = r#"}/"#;\n    84 / r#return.len()\n}\n'],
  ]) {
    const source = prefix + declaration + neighbor;
    await f.write(filename, source);
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration, declaration);
    const start = prefix.split("\n").length;
    assert.deepEqual(view.lines, [start, start + declaration.trimEnd().split("\n").length - 1]);
    const written = await f.tool.execute("raw-identifier-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
    assert.equal(written.isError, undefined);
    assert.doesNotMatch(written.details.result, /check:/);
    const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
    assert.equal(edited.isError, undefined);
    assert.doesNotMatch(edited.details.result, /check:/);
    assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
  }
});

it("ordinary multiline Rust strings keep declaration replacements away from their neighbors", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nfn otherToken() -> i32 {\n    99\n}\n";

  for (const prefix of ["", "b"]) {
    const declaration = 'fn payloadToken() {\n    let text = ' + prefix + '"first line\n}\nlast line";\n    let _ = text;\n}\n';
    await f.write("multiline.rs", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 6]);
    const replacement = await f.execute('const v = await read({query:"payloadToken", resolve:true}); return await edit(v,"fn payloadToken() {}\\n");');
    assert.doesNotMatch(replacement.details.result, /check:/);
    assert.equal(await fs.readFile(path.join(f.root, "multiline.rs"), "utf8"), "fn payloadToken() {}\n" + neighbor);
    const receipt = await f.tool.execute("multiline-rust", {code:'return await write("multiline.rs",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
  }
});

it("Rust nested block comments cannot truncate a resolved declaration or its replacement", async t => {
  const f = await engineFixture(t);
  const declaration = "fn payloadToken() {\n    /* outer comment\n       /* inner comment */\n       }\n    */\n    let answer = 42;\n    answer\n}\n";
  const neighbor = "\nfn otherToken() {\n    99\n}\n";
  await f.write("nested.rs", declaration + neighbor);
  const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.text, declaration);
  assert.deepEqual(view.lines, [1, 8]);
  await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"fn payloadToken() { 2 }\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "nested.rs"), "utf8"), "fn payloadToken() { 2 }\n" + neighbor);
});

it("Kotlin and Swift nested block comments preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const comment = "/* outer comment\n    /* inner comment */\n    } ] (\n  */";

  for (const [extension, binding] of [["kt", "val"], ["swift", "let"]]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const template of [
        "class PayloadToken {\n  " + comment + "\n  " + binding + " answer = 42\n}\n",
        "class PayloadToken " + comment + " {\n  " + binding + " answer = 42\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = ("\nclass OtherToken {\n  " + binding + " neighborSentinel = 99\n}\n").replaceAll("\n", newline);
        const replacement = ("class PayloadToken {\n  " + binding + " answer = 2\n}\n").replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, extension + ": " + template);
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("nested-comment-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }

    const malformed = await f.tool.execute("nested-comment-broken", {code:"return await write(data.path,data.source);",data:{path:filename,source:"class Broken {\n  /* outer /* inner */\n}\n"}}, undefined, undefined, {cwd:f.root});
    assert.match(malformed.details.result, /check: unterminated comment/);
  }

  // A nested opener is plain comment payload in non-nesting dialects.
  for (const extension of ["js", "java"]) {
    const written = await f.tool.execute("non-nested-comment-write", {code:"return await write(data.path,data.source);",data:{path:"plain-comments." + extension,source:"class PlainToken {\n  /* outer /* payload */\n}\n"}}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(written.details.result, /check:/);
  }
});

it("non-regex dialects preserve division after JavaScript keyword identifiers", async t => {
  const f = await engineFixture(t);

  const fixtures = [
    ["cs", "PayloadToken", 'class PayloadToken {\n  int Answer() {\n    int yield = 84;\n    return yield / "}/".Length;\n  }\n}\n', 'class OtherToken { int neighborSentinel = 99; }\n', 'class PayloadToken {}\n'],
    ["java", "PayloadToken", 'class PayloadToken {\n  int answer() {\n    int await = 84;\n    return await / "}/".length();\n  }\n}\n', 'class OtherToken { int neighborSentinel = 99; }\n', 'class PayloadToken {}\n'],
    ["kt", "PayloadToken", 'class PayloadToken {\n  fun answer(): Int {\n    val await = 84\n    return await / "}/".length\n  }\n}\n', 'class OtherToken { val neighborSentinel = 99 }\n', 'class PayloadToken {}\n'],
    ["go", "payloadToken", 'func payloadToken() int {\n  await := 84\n  return await / len("}/")\n}\n', 'func otherToken() int { return 99 }\n', 'func payloadToken() int { return 2 }\n'],
    ["cpp", "PayloadToken", 'class PayloadToken {\npublic:\n  int answer() {\n    int await = 84;\n    return await / sizeof("}/");\n  }\n};\n', 'class OtherToken { int neighborSentinel = 99; };\n', 'class PayloadToken {};\n'],
    ["rs", "payloadToken", 'fn payloadToken() -> usize {\n  let new = 84;\n  new / "}/".len()\n}\n', 'fn otherToken() -> usize { 99 }\n', 'fn payloadToken() -> usize { 2 }\n'],
  ];

  for (const [extension, symbol, body, sibling, changed] of fixtures) {
    const filename = symbol + "." + extension;
    const selector = JSON.stringify({path:filename,query:symbol,resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      const declaration = body.replaceAll("\n", newline);
      const prefix = extension === "go" ? "package fixture" + newline + newline : "";
      const neighbor = ("\n" + sibling).replaceAll("\n", newline);
      const replacement = changed.replaceAll("\n", newline);
      const source = prefix + declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found", extension);
      assert.equal(view.text, declaration, extension + ": " + JSON.stringify(newline));
      const firstLine = prefix ? 3 : 1;
      assert.deepEqual(view.lines, [firstLine, firstLine + declaration.trimEnd().split("\n").length - 1]);
      const written = await f.tool.execute("non-regex-division-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), prefix + replacement + neighbor);
    }
  }
});

it("Swift force unwraps preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.swift";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const statement of [
      'return value! / "}/".count',
      'return (value)! / "}/".count',
      'return value! /* unwrapped */ / "}/".count',
      'return value!\n      / "}/".count',
      'return (value!) / "}/".count',
      'return value != nil ? value! / "}/".count : 0',
      'return !"}/".isEmpty ? value! / "}/".count : 0',
      'return (try! /[}]/.wholeMatch(in: "}")) != nil ? 42 : 0',
      'return 84 / "}/".count',
    ]) {
      const declaration = ("class PayloadToken {\n  func answer(_ value: Int? = 84) -> Int {\n    " + statement + "\n  }\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  let neighborSentinel = 99\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  let answer = 2\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, statement + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("swift-force-unwrap-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("Swift try expressions preserve editable class boundaries around bare regexes", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.swift";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const expression of [
      'try /[}]/.wholeMatch(in: "}")',
      'try /* match */ /[}]/.wholeMatch(in: "}")',
      'try\n      /[}]/.wholeMatch(in: "}")',
      'try? /[}]/.wholeMatch(in: "}")',
      'try! /[}]/.wholeMatch(in: "}")',
    ]) {
      for (const template of [
        "class PayloadToken {\n  func match() throws -> Regex<Substring>.Match? {\n    return " + expression + "\n  }\n}\n",
        "class PayloadToken {\n  let match: () throws -> Regex<Substring>.Match?\n  init(\n    match: @escaping () throws -> Regex<Substring>.Match? = {\n      " + expression + "\n    }\n  ) {\n    self.match = match\n  }\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  let neighborSentinel = 99\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  let answer = 2\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("swift-try-regex-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("Swift extended regex literals preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.swift";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '#/[}]/#',
      '##/[}] /# payload/##',
      '#/[}]/literal/#',
      '#/\n    [}]\n    /#',
      String.raw`#/[}]\/# payload/#`,
      '#/" }/#',
      '/[}]/',
    ]) {
      for (const template of [
        "class PayloadToken {\n  let pattern = " + literal + "\n  let answer = 42\n}\n",
        "class PayloadToken {\n  let pattern: Regex<Substring>\n  init(\n    pattern: Regex<Substring> = " + literal + "\n  ) {\n    self.pattern = pattern\n  }\n  let answer = 42\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  let neighborSentinel = 99\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  let answer = 2\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("swift-extended-regex-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("Swift string interpolations preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.swift";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      String.raw`"value \("}/")"`,
      '"""\n    value \\("}/")\n    """',
      String.raw`#"value \#("}/")"#`,
      String.raw`##"value \##("}/")"##`,
      '#"""\n    value \\#("}/")\n    """#',
      String.raw`"value \("nested \("}/")")"`,
      String.raw`"value \({ () -> String in "}/" }())"`,
      String.raw`#"literal \("} [")"#`,
    ]) {
      for (const template of [
        "class PayloadToken {\n  let text = " + literal + "\n  let answer = 42\n}\n",
        "class PayloadToken {\n  let text: String\n  init(\n    text: String = " + literal + "\n  ) {\n    self.text = text\n  }\n  let answer = 42\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  let neighborSentinel = 99\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  let answer = 2\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("swift-interpolation-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("Swift multiline strings preserve editable class boundaries without false string warnings", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.swift";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '"""\n    first } [{\n    last "quote"\n    """',
      '"""\n    escaped \\""" } [{\n    last\n    """',
      '"ordinary } [\\" quote"',
    ]) {
      const declaration = ("class PayloadToken {\n  let text = " + literal + "\n  let answer = 42\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  let neighborSentinel = 99\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  let answer = 2\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, literal + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("swift-multiline-string-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v,\"answer = 42\",\"answer = 43\");");
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), declaration.replace("answer = 42", "answer = 43") + neighbor);
      await f.execute("const v = await read(" + selector + "); await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  const malformed = await f.tool.execute("swift-multiline-string-broken", {code:'return await write("Broken.swift",data);',data:'class Broken {\n  let text = """\n    missing closing delimiter\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("Swift extended string delimiters preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.swift";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '#"literal backslash \\"#',
      '#"first " } [ last"#',
      '##"first "# } [ last"##',
      '##"literal backslash \\#"##',
      '#"escaped \\#"# } [ last"#',
      '#"""\n    first """ } [{\n    last "quote"\n    """#',
      '##"""\n    first """# } [{\n    last\n    """##',
      '#"""\n    escaped \\#"""# } [{\n    last\n    """#',
      '"ordinary } [\\" quote"',
    ]) {
      const declaration = ("class PayloadToken {\n  let text = " + literal + "\n  let answer = 42\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  let neighborSentinel = 99\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  let answer = 2\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, literal + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("swift-extended-string-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  const malformed = await f.tool.execute("swift-extended-string-broken", {code:'return await write("Broken.swift",data);',data:'class Broken {\n  let text = ##"missing delimiter"#\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("Kotlin escaped identifiers preserve editable class boundaries without template interpolation", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.kt";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const name of ["renders ${(}", "renders ${name", "literal } (", "return"]) {
      const identifier = "`" + name + "`";

      for (const template of [
        "class PayloadToken {\n  val " + identifier + " = 84\n  val answer = " + identifier + " / \"}/\".length\n}\n",
        "class PayloadToken(\n  val " + identifier + ": Int = 84,\n  val answer: Int = " + identifier + " / \"}/\".length\n) {\n  val sentinel = 42\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  val neighborSentinel = 99\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  val answer = 2\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("kotlin-escaped-identifier-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("Kotlin string interpolations preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.kt";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '"value ${"} /"}"',
      '"nested ${"inner ${"} /"}"}"',
      '"value ${run { "} /" }}"',
      '"""value ${"""} [ ("""}"""',
      '"""value ${\n    run { "} /" }\n  }"""',
      '"""backslash \\${"""} [ ("""}"""',
      '"literal \\${ ] ( \\" quote"',
      '"simple ${42}"',
    ]) {
      for (const template of [
        "class PayloadToken {\n  val text = " + literal + "\n  val answer = 42\n}\n",
        "class PayloadToken(\n  val text: String = " + literal + "\n) {\n  val answer = 42\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  val neighborSentinel = 99\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  val answer = 2\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("kotlin-interpolation-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  const malformed = await f.tool.execute("kotlin-interpolation-broken", {code:'return await write("Broken.kt",data);',data:'class Broken {\n  val text = "value ${"}/"\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("Kotlin raw strings preserve editable class boundaries without false string warnings", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.kt";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '"""\n    first } [{\n    last "quote"\n    """',
      '"""\n    first } [{\n    last "quote"\\"""',
      '"""inline } [ "quote"\\"""',
      '"ordinary } [\\" quote"',
    ]) {
      for (const template of [
        "class PayloadToken {\n  val text = " + literal + "\n  val answer = 42\n}\n",
        "class PayloadToken(\n  val text: String = " + literal + "\n) {\n  val answer = 42\n}\n",
      ]) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  val neighborSentinel = 99\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  val answer = 2\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("kotlin-raw-string-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  const malformed = await f.tool.execute("kotlin-raw-string-broken", {code:'return await write("Broken.kt",data);',data:'class Broken {\n  val text = """\n    missing closing delimiter\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("C# interpolated raw strings preserve nested literal declaration boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const [dollars, quote] of [["$", '"""'], ["$$", '""""'], ["$$$", '"""""']]) {
      const open = "{".repeat(dollars.length);
      const close = "}".repeat(dollars.length);
      const literalBraces = dollars.length > 1 ? "literal " + "{".repeat(dollars.length - 1) + " ] " : "";

      for (const expression of [quote + " } [ " + quote, '$"nested {""" } [ """}"', '$$"""nested {{ """ } [ """ }}"""']) {
        const declaration = ("class PayloadToken {\n  string text = " + dollars + quote + literalBraces + "prefix " + open + " " + expression + " " + close + " suffix" + quote + ";\n}\n").replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken { int neighborSentinel; }\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken { int changed; }\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found", JSON.stringify(view));
        assert.equal(view.text, declaration, JSON.stringify(source));
        assert.deepEqual(view.lines, [1, 3]);
        const written = await f.tool.execute("interpolated-raw-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("C++ spliced digit separators preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  for (const extension of ["cpp", "cc", "h", "hpp"]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const number of ["1\\\n'000", "1'\\\n000", "1\\\n\\\n'\\\n000", "1'000"]) {
        const declaration = ("class PayloadToken {\n  long number = " + number + ";\n  char brace = '}';\n};\n").replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken { int neighborSentinel; };\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken { int changed; };\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found", JSON.stringify(view));
        assert.equal(view.text, declaration, extension + ": " + JSON.stringify(source));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("spliced-number-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("C++ spliced raw-string prefixes preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  for (const extension of ["cpp", "cc", "h", "hpp"]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const [prefix, type] of [["R", "char"], ["u8R", "char"], ["uR", "char16_t"], ["UR", "char32_t"], ["LR", "wchar_t"]]) {
        for (const splice of ["\\\n", "\\\n\\\n"]) {
          const opener = [...prefix, '"'].join(splice);
          const declaration = ("class PayloadToken {\n  const " + type + "* text = " + opener + 'tag(prefix " } [\npayload)tag";\n};\n').replaceAll("\n", newline);
          const neighbor = "\nclass OtherToken { int neighborSentinel; };\n".replaceAll("\n", newline);
          const replacement = "class PayloadToken { int changed; };\n".replaceAll("\n", newline);
          const source = declaration + neighbor;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found", JSON.stringify(view));
          assert.equal(view.text, declaration, extension + ": " + JSON.stringify(source));
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("spliced-raw-prefix-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }
});

it("C and C++ string escapes cross line splices without swallowing neighboring declarations", async t => {
  const f = await engineFixture(t);

  for (const extension of ["cpp", "cc", "h", "hpp"]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const splice of ["\\\n", "\\\n\\\n"]) {
        // After phase-two splicing, the first backslash escapes the quoted brace payload.
        const literal = '"prefix \\' + splice + '" } [ payload"';
        const declaration = ("class PayloadToken {\n  const char* text = " + literal + ";\n};\n").replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken { int neighborSentinel; };\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken { int changed; };\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found", JSON.stringify(view));
        assert.equal(view.text, declaration, extension + ": " + JSON.stringify(source));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("spliced-string-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const cSource = ("const char* payload = " + literal + ";\nint neighborSentinel;\n").replaceAll("\n", newline);
        const cWritten = await f.tool.execute("c-spliced-string-write", {code:'return await write("strings.c",data);',data:cSource}, undefined, undefined, {cwd:f.root});
        assert.equal(cWritten.isError, undefined);
        assert.doesNotMatch(cWritten.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  for (const extension of ["js", "java"]) {
    const source = 'class PayloadToken {\n  const char* text = "prefix \\\\\n" } [ payload";\n};\n';
    const written = await f.tool.execute("unspliced-string-control", {code:"return await write(data.path,data.source);",data:{path:"PayloadToken." + extension,source}}, undefined, undefined, {cwd:f.root});
    assert.match(written.details.result, /check: unterminated string/);
  }
});

it("C and C++ spliced comment openers preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  for (const extension of ["cpp", "cc", "h", "hpp"]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const splice of ["\\\n", "\\\n\\\n"]) {
        for (const marker of ["*", "/"]) {
          const comment = "/" + splice + marker + ' ignored } " [' + (marker === "*" ? " */" : "");

          for (const template of [
            "class PayloadToken {\n  " + comment + "\n  int answer;\n};\n",
            "class PayloadToken " + comment + "\n{\n  int answer;\n};\n",
          ]) {
            const declaration = template.replaceAll("\n", newline);
            const neighbor = "\nclass OtherToken { int neighborSentinel; };\n".replaceAll("\n", newline);
            const replacement = "class PayloadToken { int changed; };\n".replaceAll("\n", newline);
            const source = declaration + neighbor;
            await f.write(filename, source);
            const view = (await f.execute("return await read(" + selector + ");")).details.result;
            assert.equal(view.status, "found", JSON.stringify(view));
            assert.equal(view.text, declaration, extension + ": " + JSON.stringify(template));
            assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
            const written = await f.tool.execute("spliced-comment-opener-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
            assert.equal(written.isError, undefined);
            assert.doesNotMatch(written.details.result, /check:/);

            if (extension === "cpp") {
              const cSource = source.replaceAll("class ", "struct ");
              const cWritten = await f.tool.execute("c-spliced-comment-opener-write", {code:'return await write("comments.c",data);',data:cSource}, undefined, undefined, {cwd:f.root});
              assert.equal(cWritten.isError, undefined);
              assert.doesNotMatch(cWritten.details.result, /check:/);
            }

            const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
            assert.equal(edited.isError, undefined);
            assert.doesNotMatch(edited.details.result, /check:/);
            assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
          }
        }
      }
    }
  }

  // Outside C/C++, a splice cannot turn two separate characters into a comment.
  for (const extension of ["js", "java"]) {
    for (const marker of ["*", "/"]) {
      const source = 'class PayloadToken {\n  /\\\n' + marker + ' ignored } " [' + (marker === "*" ? " */" : "") + '\n}\n';
      const written = await f.tool.execute("unspliced-opener-control", {code:"return await write(data.path,data.source);",data:{path:"opener." + extension,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.match(written.details.result, /check:/);
    }
  }
});

it("C and C++ spliced block-comment closers preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  for (const extension of ["cpp", "cc", "h", "hpp"]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const splice of ["\\\n", "\\\n\\\n"]) {
        for (const template of [
          "class PayloadToken {\n  /* ignored } \" [ *" + splice + "/\n  int answer;\n};\n",
          "class PayloadToken /* ignored } \" [ *" + splice + "/\n{\n  int answer;\n};\n",
        ]) {
          const declaration = template.replaceAll("\n", newline);
          const neighbor = "\nclass OtherToken { int neighborSentinel; };\n/* ordinary trailing comment */\n".replaceAll("\n", newline);
          const replacement = "class PayloadToken { int changed; };\n".replaceAll("\n", newline);
          const source = declaration + neighbor;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found", JSON.stringify(view));
          assert.equal(view.text, declaration, extension + ": " + JSON.stringify(template));
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("spliced-block-comment-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);

          if (extension === "cpp") {
            const cSource = source.replaceAll("class ", "struct ");
            const cWritten = await f.tool.execute("c-spliced-block-comment-write", {code:'return await write("comments.c",data);',data:cSource}, undefined, undefined, {cwd:f.root});
            assert.equal(cWritten.isError, undefined);
            assert.doesNotMatch(cWritten.details.result, /check:/);
          }

          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }
    }
  }

  // Non-C dialects keep a spliced-looking closer inside the comment payload.
  for (const extension of ["js", "java"]) {
    const field = extension === "js" ? "answer = 42;" : "int answer;";
    const declaration = 'class PayloadToken {\n  /* ignored *\\\n/ } " [ */\n  ' + field + '\n}\n';
    const neighbor = "\nclass OtherToken {}\n";
    const filename = "PayloadToken." + extension;
    await f.write(filename, declaration + neighbor);
    const view = (await f.execute("return await read(" + JSON.stringify({path:filename,query:"PayloadToken",resolve:true}) + ");")).details.result;
    assert.equal(view.text, declaration);
  }
});

it("C and C++ spliced line comments preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);

  for (const extension of ["cpp", "cc", "h", "hpp"]) {
    const filename = "PayloadToken." + extension;
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

    for (const newline of ["\n", "\r\n"]) {
      for (const slashes of ["\\", "\\\\"]) {
        for (const template of [
          "class PayloadToken {\n  // ignored " + slashes + "\n  } \" [ \\\n  still ignored }\n  int answer = 42;\n};\n",
          "class PayloadToken // ignored " + slashes + "\n  } \" [ \\\n  still ignored }\n{\n  int answer = 42;\n};\n",
        ]) {
          const declaration = template.replaceAll("\n", newline);
          const neighbor = "\nclass OtherToken { int neighborSentinel = 99; };\n".replaceAll("\n", newline);
          const replacement = "class PayloadToken { int answer = 2; };\n".replaceAll("\n", newline);
          const source = declaration + neighbor;
          await f.write(filename, source);
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found", JSON.stringify(view));
          assert.equal(view.text, declaration, extension + ": " + JSON.stringify(template));
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const written = await f.tool.execute("cpp-spliced-comment-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
          assert.equal(written.isError, undefined);
          assert.doesNotMatch(written.details.result, /check:/);
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }

      const cSource = "int payloadToken(void) {\n  // ignored \\\n  } \" [\n  return 42;\n}\n".replaceAll("\n", newline);
      const written = await f.tool.execute("c-spliced-comment-write", {code:'return await write("comments.c",data);',data:cSource}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
    }
  }

  // A final backslash does not splice a JavaScript or Java line comment.
  for (const extension of ["js", "java"]) {
    const declaration = "class PayloadToken {\n  // note \\\n}\n";
    const neighbor = "\nclass OtherToken {}\n";
    const filename = "PayloadToken." + extension;
    await f.write(filename, declaration + neighbor);
    const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});
    const view = (await f.execute("return await read(" + selector + ");")).details.result;
    assert.equal(view.text, declaration);
    const written = await f.tool.execute("unspliced-comment-control", {code:"return await write(data.path,data.source);",data:{path:filename,source:declaration + neighbor}}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(written.details.result, /check:/);
  }
});

it("C# line-comment terminators preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const terminator of ["\r", "\u0085", "\u2028", "\u2029", "\n"]) {
      const templates = [
        "class PayloadToken {\n  // note" + terminator + "  public int answer = 42; }\n",
        "class PayloadToken // note" + terminator + "{\n  public int answer = 42;\n}\n",
        "class PayloadToken {\n  /* note" + terminator + " } \" [ */\n  public int answer = 42;\n}\n",
      ];

      for (const template of templates) {
        const declaration = template.replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  public int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  public int answer = 2;\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, template + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("csharp-comment-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  // C#'s extra terminators remain payload in Rust line comments.
  for (const terminator of ["\u0085", "\u2028", "\u2029"]) {
    const declaration = 'struct PayloadToken {\n  // note' + terminator + ' } " [\n  answer: i32,\n}\n';
    const neighbor = "\nstruct OtherToken { neighbor_sentinel: i32 }\n";
    await f.write("comments.rs", declaration + neighbor);
    const view = (await f.execute('return await read({path:"comments.rs",query:"PayloadToken",resolve:true});')).details.result;
    assert.equal(view.text, declaration);
    const written = await f.tool.execute("csharp-comment-rust-control", {code:'return await write("comments.rs",data);',data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(written.details.result, /check:/);
  }
});

it("C# verbatim strings preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      String.raw`@"C:\folder\"`,
      String.raw`@"first \"" } [{ last"`,
      '@"first } [{\n    last ""quote""\n    "',
      String.raw`"ordinary } [\" quote"`,
    ]) {
      const declaration = ("class PayloadToken {\n  string text = " + literal + ";\n  int answer = 42;\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  int answer = 2;\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, literal + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("csharp-verbatim-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  const malformed = await f.tool.execute("csharp-verbatim-broken", {code:'return await write("Broken.cs",data);',data:'class Broken {\n  string text = @"missing closing delimiter"";\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("C# null-forgiving operators preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const statement of [
      'return value! / "}/".Length;',
      'return value /* asserted */ ! / "}/".Length;',
      'return value\n      ! / "}/".Length;',
      'return value /*\n      asserted\n    */ ! / "}/".Length;',
      'return value / "}/".Length;',
      'return (value!) / "}/".Length;',
      'return value != null ? value / "}/".Length : null;',
      'return !"}/".StartsWith("x") ? value / "}/".Length : 0;',
    ]) {
      const declaration = ("class PayloadToken {\n  public int? Answer(int? value = 84) {\n    " + statement + "\n  }\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  public int NeighborSentinel() { return 99; }\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  public int Answer() { return 2; }\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, statement + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("csharp-null-forgiving-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("C# verbatim identifiers preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const identifier of ["@return", "@throw", "@new", "@await", "returnValue"]) {
      for (const initializer of [
        identifier + ' / "}/".Length',
        'System.Math.Min(\n    ' + identifier + ' / "}/".Length,\n    42\n  )',
      ]) {
        const declaration = ("class PayloadToken {\n  const int " + identifier + " = 84;\n  public int answer = " + initializer + ";\n}\n").replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  public int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  public int answer = 2;\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, identifier + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("csharp-verbatim-identifier-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }
});

it("C# alternate interpolated verbatim prefixes preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const prefix of ["@$", "$@"]) {
      for (const literal of [
        String.raw`"C:\folder\{42}\"`,
        '"first ""quote""\n    }} [ ( {42}\n    \\"',
      ]) {
        const declaration = ("class PayloadToken {\n  string text = " + prefix + literal + ";\n  int answer = 42;\n}\n").replaceAll("\n", newline);
        const neighbor = "\nclass OtherToken {\n  int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
        const replacement = "class PayloadToken {\n  int answer = 2;\n}\n".replaceAll("\n", newline);
        const source = declaration + neighbor;
        await f.write(filename, source);
        const view = (await f.execute("return await read(" + selector + ");")).details.result;
        assert.equal(view.status, "found");
        assert.equal(view.text, declaration, prefix + literal + ": " + JSON.stringify(newline));
        assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
        const written = await f.tool.execute("csharp-interpolated-verbatim-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
        assert.equal(written.isError, undefined);
        assert.doesNotMatch(written.details.result, /check:/);
        const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
        assert.equal(edited.isError, undefined);
        assert.doesNotMatch(edited.details.result, /check:/);
        assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
      }
    }
  }

  const malformed = await f.tool.execute("csharp-interpolated-verbatim-broken", {code:'return await write("Broken.cs",data);',data:'class Broken {\n  string text = @$"missing closing delimiter"";\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("C# string interpolations preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      String.raw`$"value {"}/"}"`,
      String.raw`$@"value {"}/"}"`,
      String.raw`@$"value {"}/"}"`,
      String.raw`$"nested {$"inner {"}/"}"}"`,
      String.raw`$@"nested {@$"inner {"}/"}"}"`,
      String.raw`$"value {new[] { "}/" }[0]}"`,
      String.raw`$"value {((System.Func<string>)(() => { return "}/"; }))()}"`,
      String.raw`$@"value {@"C:\folder\" + "}/"}"`,
      String.raw`$"literal {{ ] ( }} [ ( \"quote\" {42:D4}"`,
      '$@"literal {{ ] ( }} [ ( ""quote""\n    {42:D4}\\"',
      '@$"literal {{ ] ( }} [ ( ""quote""\n    {42:D4}\\"',
      String.raw`$"aligned {"}/",4}"`,
      '$"date {System.DateTime.Today:yyyy/MM/dd (ddd}"',
      '$@"date {System.DateTime.Today:yyyy ] [ (}"',
      String.raw`$"qualified {(global::System.String.Concat("}/", "tail"))}"`,
      String.raw`$"conditional {(true ? "}/" : "tail")}"`,
      String.raw`"ordinary } [\" quote"`,
      String.raw`@"ordinary { ""quote"" \"`,
      '$""',
    ]) {
      const declaration = ("class PayloadToken {\n  public string text = " + literal + ";\n  public int answer = 42;\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  public int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  public int answer = 2;\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, literal + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("csharp-interpolation-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  const malformed = await f.tool.execute("csharp-interpolation-broken", {code:'return await write("Broken.cs",data);',data:'class Broken {\n  string text = $"value {"}/";\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("C# raw strings preserve editable class boundaries with matching quote counts", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.cs";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '"""\n    first } [{\n    last "quote"\n    """',
      String.raw`"""inline " } [{ last\"""`,
      '""""\n    shorter """ } [{\n    last\n    """"',
      '"""""inline """" } [{ last"""""',
      String.raw`"ordinary } [\" quote"`,
    ]) {
      const declaration = ("class PayloadToken {\n  string text = " + literal + ";\n  int answer = 42;\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  int answer = 2;\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, literal + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("csharp-raw-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  const malformed = await f.tool.execute("csharp-raw-broken", {code:'return await write("Broken.cs",data);',data:'class Broken {\n  string text = """"\n    missing matching delimiter\n    """;\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("Java carriage-return line comments preserve editable class boundaries", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.java";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    const neighbor = "\nclass OtherToken {\n  int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
    const replacement = "class PayloadToken {\n  int answer = 2;\n}\n".replaceAll("\n", newline);

    const templates = [
      "class PayloadToken {\n  // note\r  int answer = 42; }\n",
      "class PayloadToken // note\r{\n  int answer = 42;\n}\n",
      "class PayloadToken {\n  // note\n  int answer = 42;\n}\n",
      'class PayloadToken {\n  /* note\r } " [ */\n  int answer = 42;\n}\n',
      ...["\u0085", "\u2028", "\u2029"].map(terminator => 'class PayloadToken {\n  // note' + terminator + ' } " [\n  int answer = 42;\n}\n'),
    ];

    for (const template of templates) {
      const declaration = template.replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, JSON.stringify(template));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("java-comment-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("Java text blocks preserve editable class boundaries without false string warnings", async t => {
  const f = await engineFixture(t);
  const filename = "PayloadToken.java";
  const selector = JSON.stringify({path:filename,query:"PayloadToken",resolve:true});

  for (const newline of ["\n", "\r\n"]) {
    for (const literal of [
      '"""\n    first } [{\n    last "quote"\n    """',
      '"""\n    escaped \\""" } [{\n    last\n    """',
      '"ordinary } [\\" quote"',
    ]) {
      const declaration = ("class PayloadToken {\n  String text = " + literal + ";\n}\n").replaceAll("\n", newline);
      const neighbor = "\nclass OtherToken {\n  int neighborSentinel = 99;\n}\n".replaceAll("\n", newline);
      const replacement = "class PayloadToken {\n  int value = 2;\n}\n".replaceAll("\n", newline);
      const source = declaration + neighbor;
      await f.write(filename, source);
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, literal + ": " + JSON.stringify(newline));
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("java-text-block-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }

  const malformed = await f.tool.execute("java-text-block-broken", {code:'return await write("Broken.java",data);',data:'class Broken {\n  String text = """\n    missing closing delimiter\n}\n'}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("C++ digit separators keep focused class outlines bounded without false string warnings", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nclass OtherToken {\npublic:\n  int neighborSentinel = 99;\n};\n";

  for (const number of ["1'000", "0b1010'1100", "0xA'B", "1.2'3e+4", "0x1'2.Ap-1"]) {
    const declaration = "class PayloadToken {\npublic:\n  double amount = " + number + ";\n  char plain = '7';\n  char byte = u8'7';\n  wchar_t wide = L'7';\n};\n";
    await f.write("numbers.cpp", declaration + neighbor);
    const outline = (await f.execute('return await read("numbers.cpp",{about:"PayloadToken"});')).details.result;
    assert.ok(outline.includes("double amount = " + number));
    assert.match(outline, /class OtherToken/);
    assert.doesNotMatch(outline, /neighborSentinel/, number);
    const receipt = await f.tool.execute("cpp-number-write", {code:'return await write("numbers.cpp",data);', data:declaration + neighbor}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(receipt.details.result, /check:/);
    const edited = await f.tool.execute("cpp-number-edit", {code:'return await edit("numbers.cpp",data.oldText,"double amount = 2");', data:{oldText:"double amount = " + number}}, undefined, undefined, {cwd:f.root});
    assert.doesNotMatch(edited.details.result, /check:/);
    assert.equal(await fs.readFile(path.join(f.root, "numbers.cpp"), "utf8"), declaration.replace("double amount = " + number, "double amount = 2") + neighbor);
  }

  const malformed = await f.tool.execute("cpp-character-write", {code:'return await write("broken.cpp",data);', data:"class Broken {\n  char value = u8'7;\n};\n"}, undefined, undefined, {cwd:f.root});
  assert.match(malformed.details.result, /check: unterminated string/);
});

it("a wrapped JS signature span includes the body after the closing paren", async t => {
  const f = await engineFixture(t);
  await f.write("nest.js", `export function payloadToken(
  selector,
) {
  return selector
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "nest.js");
  assert.match(source.text, /^export function payloadToken/);
  assert.match(source.text, /return selector/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 5]);
});

it("a JS declaration with a next-line brace resolves and replaces its whole body", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nconst untouchedBinding = 1;\n{\n  void untouchedBinding;\n}\n\nexport function otherToken() { return 99; }\n";
  await f.write("next-line.js", "export function payloadToken()\n{\n  return 42;\n}\n" + neighbor);
  const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.deepEqual(view.lines, [1, 4]);
  assert.equal(view.text, "export function payloadToken()\n{\n  return 42;\n}\n");
  const binding = (await f.execute('return await read({query:"untouchedBinding", resolve:true});')).details.result;
  assert.equal(binding.text, "const untouchedBinding = 1;\n");
  await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export function payloadToken() { return 2; }\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "next-line.js"), "utf8"), "export function payloadToken() { return 2; }\n" + neighbor);
});

it("comment-separated next-line declaration bodies retain complete editable views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts"]) {
    const filename = "comment-body." + extension;

    for (const newline of ["\n", "\r\n"]) {
      for (const gap of ["\n/* body { [ ( */\n", "\n// body } ] )\n", "\n/* first */ // second\n"]) {
        for (const [header, body] of [
          ["export function payloadToken()", "{\n  return 42;\n}\n"],
          ["export class payloadToken", "{\n  value() { return 42; }\n}\n"],
        ]) {
          const declaration = (header + gap + body).replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          assert.equal(new Function(declaration.replace("export ", "") + "return typeof payloadToken;")(), "function");
          await f.write(filename, declaration + neighbor);
          const selector = JSON.stringify({path:filename, query:"payloadToken", resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + header + gap);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const replacement = "export function payloadToken() { return 3; }" + newline;
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }

      const declaration = "export const payloadToken = 42;" + newline;
      const separate = "/* separate block */" + newline + "{ void payloadToken; }" + newline;
      await f.write(filename, declaration + separate);
      const selector = JSON.stringify({path:filename, query:"payloadToken", resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.text, declaration);
      assert.deepEqual(view.lines, [1, 1]);
    }
  }
});

it("JavaScript array binding views replace the whole initializer and preserve neighbors", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";

  for (const declaration of [
    'export const payloadToken = [\n  "alpha",\n  "beta",\n];\n',
    'export const payloadToken = [\n  { name: "alpha" },\n  { name: "beta" },\n];\n',
  ]) {
    await f.write("array.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 4]);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export const payloadToken = [];\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "array.js"), "utf8"), "export const payloadToken = [];\n" + neighbor);
  }
});

it("a wrapped JavaScript call initializer cannot consume the neighboring declaration", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export const payloadToken = Object.freeze({ value: 2 });\n";

  for (const declaration of [
    "export const payloadToken = Object.freeze({\n  value: 42,\n});\n",
    "export const payloadToken = Math.max(\n  42, 99,\n);\n",
    "export const payloadToken = (\n  value,\n) => {\n  return value;\n};\n",
    "export const payloadToken = function(\n  value,\n) {\n  return value;\n};\n",
  ]) {
    await f.write("call.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export const payloadToken = Object.freeze({ value: 2 });\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "call.js"), "utf8"), replacement + neighbor);
  }
});

it("Go raw strings do not interpolate shell placeholders in resolved declarations", async t => {
  const f = await engineFixture(t);
  const declaration = "func payloadToken() string {\n    return `echo ${HOME\nraw text`\n}\n";
  const neighbor = "\nfunc otherToken() string {\n    return \"neighbor\"\n}\n";
  await f.write("raw.go", declaration + neighbor);
  const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.text, declaration);
  assert.deepEqual(view.lines, [1, 4]);
  await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"func payloadToken() string { return `replacement` }\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "raw.go"), "utf8"), "func payloadToken() string { return `replacement` }\n" + neighbor);
});

it("comment-separated aggregate binding initializers retain complete editable views", async t => {
  const f = await engineFixture(t);

  for (const extension of ["js", "ts"]) {
    const filename = "comment-initializer." + extension;

    for (const newline of ["\n", "\r\n"]) {
      for (const gap of ["\n  /* initializer { [ ( */\n  ", "\n  // initializer } ] )\n  ", "\n  /* first */ // second\n  "]) {
        for (const initializer of ["{\n    value: 42\n  }", "[\n    42\n  ]"]) {
          const declaration = ("export const payloadToken =" + gap + initializer + ";\n").replaceAll("\n", newline);
          const neighbor = newline + "export function otherToken() { return 99; }" + newline;
          assert.equal(new Function(declaration.replace("export ", "") + "return Array.isArray(payloadToken) ? payloadToken[0] : payloadToken.value;")(), 42);
          await f.write(filename, declaration + neighbor);
          const selector = JSON.stringify({path:filename, query:"payloadToken", resolve:true});
          const view = (await f.execute("return await read(" + selector + ");")).details.result;
          assert.equal(view.status, "found");
          assert.equal(view.text, declaration, extension + ": " + gap + initializer);
          assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
          const replacement = "export const payloadToken = 3;" + newline;
          const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
          assert.equal(edited.isError, undefined);
          assert.doesNotMatch(edited.details.result, /check:/);
          assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
        }
      }

      const declaration = "export const payloadToken = 42;" + newline;
      const separate = "/* separate block */" + newline + "{ console.log(1); }" + newline;
      await f.write(filename, declaration + separate);
      const view = (await f.execute("return await read(" + JSON.stringify({path:filename, query:"payloadToken", resolve:true}) + ");")).details.result;
      assert.equal(view.text, declaration);
      assert.deepEqual(view.lines, [1, 1]);
    }
  }
});

it("JavaScript next-line object and array initializers resolve and replace the whole binding", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";

  for (const declaration of [
    "export const payloadToken =\n{\n  value: 42,\n};\n",
    "export const payloadToken =\n[\n  42,\n];\n",
    "export const payloadToken = // initializer follows\n{\n  value: 42,\n};\n",
  ]) {
    await f.write("initializer.js", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, 4]);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export const payloadToken = 2;\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "initializer.js"), "utf8"), "export const payloadToken = 2;\n" + neighbor);
  }
});

it("multiline JavaScript template bindings resolve and replace the entire literal", async t => {
  const f = await engineFixture(t);
  const declaration = 'export const payloadToken = `first line\nsecond line\nlast line`;\n';
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  await f.write("template.js", declaration + neighbor);
  const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(view.status, "found");
  assert.equal(view.text, declaration);
  assert.deepEqual(view.lines, [1, 3]);
  await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export const payloadToken = `replacement`;\\n");');
  assert.equal(await fs.readFile(path.join(f.root, "template.js"), "utf8"), "export const payloadToken = `replacement`;\n" + neighbor);
});

it("TypeScript non-null assertions preserve editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["ts", "tsx"]) {
    const filename = "non-null." + extension;

    for (const [params, statement] of [
      ["value = 84", 'return value! / "}/".length;'],
      ["value = 84", 'return value!! / "}/".length;'],
      ["value = { amount: 84 }", 'return value.amount /* asserted */ ! / "}/".length;'],
      ['value = [84][0]! / "}/".length', "return value;"],
      ['\n  value = [84][0]! / "}/".length,\n  unused\n', "return value;"],
      ["value = 84", 'return `${value! / "}/".length}`;'],
      ["value = 84", 'return ! /}/.test("x") ? 42 : 0;'],
      ["value = 84", 'value\n  ! /}/.test("x"); return 42;'],
      ["value = 84", 'value /*\n  new statement\n  */ ! /}/.test("x"); return 42;'],
      ["value = 84", 'return value !== /}/.lastIndex ? 42 : 0;'],
    ]) {
      const declaration = "export function payloadToken(" + params + ") {\n  " + statement + "\n}\n";
      const source = declaration + neighbor;
      await f.write(filename, source);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + params + ": " + statement);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const written = await f.tool.execute("non-null-write", {code:"return await write(data.path,data.source);",data:{path:filename,source}}, undefined, undefined, {cwd:f.root});
      assert.equal(written.isError, undefined);
      assert.doesNotMatch(written.details.result, /check:/);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("TypeScript function return types preserve complete editable declaration boundaries", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";
  const replacement = "export function payloadToken() { return 2; }\n";

  for (const extension of ["ts", "tsx"]) {
    const filename = "function-return-type." + extension;

    for (const declaration of [
      "export function payloadToken(): () => { value: number } {\n  return () => ({ value: 42 });\n}\n",
      "export function payloadToken(): () => {\n  value: number;\n} {\n  return () => ({ value: 42 });\n}\n",
      "export function payloadToken(\n): () => { value: number } {\n  return () => ({ value: 42 });\n}\n",
      "export function payloadToken(): () => { value: number }\n{\n  return () => ({ value: 42 });\n}\n",
      // A generic's closing > precedes the actual body, not another return-type object.
      "export function payloadToken(): Promise<number> {\n  return Promise.resolve(42);\n}\n",
      "export function payloadToken(\n): Promise<number> {\n  return Promise.resolve(42);\n}\n",
      "export function payloadToken(): Promise<{ value: number }> {\n  return Promise.resolve({ value: 42 });\n}\n",
    ]) {
      await f.write(filename, declaration + neighbor);
      const selector = JSON.stringify({path:filename,query:"payloadToken",resolve:true});
      const view = (await f.execute("return await read(" + selector + ");")).details.result;
      assert.equal(view.status, "found");
      assert.equal(view.text, declaration, extension + ": " + declaration);
      assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
      const edited = await f.execute("const v = await read(" + selector + "); return await edit(v," + JSON.stringify(replacement) + ");");
      assert.equal(edited.isError, undefined);
      assert.doesNotMatch(edited.details.result, /check:/);
      assert.equal(await fs.readFile(path.join(f.root, filename), "utf8"), replacement + neighbor);
    }
  }
});

it("TypeScript object return types do not truncate editable declaration views", async t => {
  const f = await engineFixture(t);
  const neighbor = "\nexport function otherToken() { return 99; }\n";

  for (const declaration of [
    "export function payloadToken(): { value: number } {\n  return { value: 42 };\n}\n",
    "export function payloadToken(): {\n  value: number;\n}\n{\n  return { value: 42 };\n}\n",
  ]) {
    await f.write("return-type.ts", declaration + neighbor);
    const view = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
    assert.equal(view.status, "found");
    assert.equal(view.text, declaration);
    assert.deepEqual(view.lines, [1, declaration.trimEnd().split("\n").length]);
    await f.execute('const v = await read({query:"payloadToken", resolve:true}); await edit(v,"export function payloadToken() { return 2; }\\n");');
    assert.equal(await fs.readFile(path.join(f.root, "return-type.ts"), "utf8"), "export function payloadToken() { return 2; }\n" + neighbor);
  }
});

it("a JS declaration span includes the body after destructured parameters", async t => {
  const f = await engineFixture(t);
  await f.write("nest.js", `export function payloadToken({ selector }) {
  return selector;
}

export function otherToken() { return 1; }
`);
  const source = (await f.execute('return await read({query:"payloadToken", resolve:true});')).details.result;
  assert.equal(source.status, "found", JSON.stringify(source));
  assert.equal(source.path, "nest.js");
  assert.match(source.text, /^export function payloadToken/);
  assert.match(source.text, /return selector/);
  assert.doesNotMatch(source.text, /otherToken/);
  assert.deepEqual(source.lines, [1, 3]);
});
