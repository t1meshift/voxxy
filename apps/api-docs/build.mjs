// Builds the API reference pages for the landing site.
//
// 1. TypeDoc reads the library's public entry points and writes a JSON model (TypeScript 6 lives in this package,
//    because TypeDoc does not support TypeScript 7 yet).
// 2. This script turns that model into plain HTML pages in apps/landing/api/, which the landing's Vite build then
//    processes like any other page (fonts and styles come from ../style.css and ../api.css).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const src = here("../../packages/voxxy/src/");
const jsonPath = here("./dist/api.json");
const outDir = here("../landing/api/");

/** Public entry points, in the order the reference lists them. */
const MODULES = [
  { name: "index", path: "voxxy", entry: "index.ts", about: "The core: createVoxxy, the provider contracts, microphone recorder, audio player, model manager and sentence splitter." },
  { name: "stt/moonshine", path: "voxxy/stt/moonshine", entry: "stt/moonshine.ts", about: "Moonshine tiny speech recognition, running in its own worker. English." },
  { name: "tts/paradee", path: "voxxy/tts/paradee", entry: "tts/paradee.ts", about: "Paradee speech synthesis, running in its own worker. English." },
  { name: "stt/platform", path: "voxxy/stt/platform", entry: "stt/platform.ts", about: "The browser's own speech recognition, with a note on whether audio leaves the device." },
  { name: "tts/platform", path: "voxxy/tts/platform", entry: "tts/platform.ts", about: "The browser's own speech synthesis." },
  { name: "serve", path: "voxxy/serve", entry: "serve.ts", about: "Worker-side helpers for writing your own worker-backed adapter." },
  { name: "testing", path: "voxxy/testing", entry: "testing.ts", about: "Fake recorder and player, for tests." },
];
const START_HERE = ["createVoxxy", "Voxxy", "SttProvider", "TtsProvider", "createMicRecorder", "createWebAudioPlayer"];

// --- 1. TypeDoc -------------------------------------------------------------------------------------------------

mkdirSync(here("./dist/"), { recursive: true });
execFileSync(
  "pnpm",
  [
    "exec", "typedoc",
    "--tsconfig", here("./tsconfig.json"),
    "--entryPoints", ...MODULES.map((m) => src + m.entry),
    "--json", jsonPath,
    "--sort", "source-order",
    "--excludeInternal",
    "--disableSources",
    "--logLevel", "Error",
  ],
  { cwd: here("./"), stdio: "inherit" },
);
const model = JSON.parse(readFileSync(jsonPath, "utf8"));
const { version } = JSON.parse(readFileSync(here("../../packages/voxxy/package.json"), "utf8"));
const unstable = version.startsWith("0.");

// --- 2. Model helpers -------------------------------------------------------------------------------------------

const K = {
  Variable: 32, Function: 64, Class: 128, Interface: 256, Constructor: 512, Property: 1024, Method: 2048,
  CallSignature: 4096, Accessor: 262144, TypeAlias: 2097152,
};
const GROUPS = [
  [K.Function, "Functions"],
  [K.Class, "Classes"],
  [K.Interface, "Interfaces"],
  [K.TypeAlias, "Types"],
  [K.Variable, "Variables"],
];
const KIND_LABEL = new Map([
  [K.Function, "function"], [K.Class, "class"], [K.Interface, "interface"], [K.TypeAlias, "type"], [K.Variable, "const"],
]);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const plainLen = (html) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").length;
const slugOf = (mod) => (mod.name === "index" ? "voxxy" : mod.name.replace("/", "-"));

// Every documented thing gets a place to link to.
const where = new Map(); // reflection id -> { href, name }
const modules = MODULES.map((def) => {
  const node = model.children.find((child) => child.name === def.name);
  if (!node) throw new Error(`TypeDoc produced no module for ${def.name}`);
  return { ...def, node, slug: slugOf(def) };
});
for (const mod of modules) {
  for (const item of mod.node.children ?? []) {
    where.set(item.id, { href: `${mod.slug}.html#${item.name}`, name: item.name });
    for (const member of item.children ?? []) {
      where.set(member.id, { href: `${mod.slug}.html#${item.name}.${member.name}`, name: `${item.name}.${member.name}` });
    }
  }
}

// --- 3. Types as HTML -------------------------------------------------------------------------------------------

const ref = (text, id) => {
  const place = typeof id === "number" ? where.get(id) : undefined;
  return place ? `<a class="t-ref" href="${place.href}">${esc(text)}</a>` : `<span class="t-ref">${esc(text)}</span>`;
};

function typeHtml(t, depth = 0) {
  if (!t) return "unknown";
  switch (t.type) {
    case "intrinsic": return `<span class="t-kw">${esc(t.name)}</span>`;
    case "literal": return `<span class="t-lit">${esc(typeof t.value === "string" ? JSON.stringify(t.value) : String(t.value))}</span>`;
    case "reference": {
      const args = t.typeArguments?.length ? `&lt;${t.typeArguments.map((a) => typeHtml(a, depth)).join(", ")}&gt;` : "";
      return ref(t.name, t.target) + args;
    }
    case "union": {
      const parts = t.types.map((u) => typeHtml(u, depth));
      return parts.reduce((n, p) => n + plainLen(p), 0) > 70 && depth === 0
        ? parts.join("\n  | ")
        : parts.join(" | ");
    }
    case "intersection": return t.types.map((u) => typeHtml(u, depth)).join(" &amp; ");
    case "array": {
      const inner = typeHtml(t.elementType, depth);
      return /[|&]|=&gt;/.test(inner.replace(/<[^>]+>/g, "")) ? `(${inner})[]` : `${inner}[]`;
    }
    case "tuple": return `[${(t.elements ?? []).map((e) => typeHtml(e, depth)).join(", ")}]`;
    case "namedTupleMember": return `${esc(t.name)}${t.isOptional ? "?" : ""}: ${typeHtml(t.element, depth)}`;
    case "optional": return `${typeHtml(t.elementType, depth)}?`;
    case "rest": return `...${typeHtml(t.elementType, depth)}`;
    case "typeOperator": return `<span class="t-kw">${esc(t.operator)}</span> ${typeHtml(t.target, depth)}`;
    case "indexedAccess": return `${typeHtml(t.objectType, depth)}[${typeHtml(t.indexType, depth)}]`;
    case "query": return `<span class="t-kw">typeof</span> ${typeHtml(t.queryType, depth)}`;
    case "predicate": return `${t.asserts ? "asserts " : ""}${esc(t.name)}${t.targetType ? ` is ${typeHtml(t.targetType, depth)}` : ""}`;
    case "templateLiteral": return `<span class="t-lit">\`${esc(t.head)}${(t.tail ?? []).map(([ty, text]) => "${" + typeHtml(ty, depth) + "}" + esc(text)).join("")}\`</span>`;
    case "conditional": return `${typeHtml(t.checkType, depth)} <span class="t-kw">extends</span> ${typeHtml(t.extendsType, depth)} ? ${typeHtml(t.trueType, depth)} : ${typeHtml(t.falseType, depth)}`;
    case "mapped": return `{ [${esc(t.parameter)} in ${typeHtml(t.parameterType, depth)}]: ${typeHtml(t.templateType, depth)} }`;
    case "reflection": return declarationHtml(t.declaration, depth);
    default: return esc(t.name ?? t.type ?? "unknown");
  }
}

function typeParamsHtml(list) {
  if (!list?.length) return "";
  return `&lt;${list.map((p) => esc(p.name) + (p.type ? ` <span class="t-kw">extends</span> ${typeHtml(p.type)}` : "") + (p.default ? ` = ${typeHtml(p.default)}` : "")).join(", ")}&gt;`;
}

function paramHtml(p) {
  const rest = p.flags?.isRest ? "..." : "";
  const optional = p.flags?.isOptional || p.defaultValue !== undefined ? "?" : "";
  return `${rest}${esc(p.name)}${optional}: ${typeHtml(p.type, 1)}`;
}

/** `(a: A, b?: B): R`; one parameter per line when it would be wide. */
function signatureTail(sig, arrow) {
  const params = (sig.parameters ?? []).map(paramHtml);
  const ret = typeHtml(sig.type, 1);
  const wide = params.reduce((n, p) => n + plainLen(p), 0) > 60;
  const list = wide ? `\n  ${params.join(",\n  ")}\n` : params.join(", ");
  return `(${list})${arrow ? " =&gt; " : ": "}${ret}`;
}

function declarationHtml(decl, depth) {
  const members = [];
  for (const child of decl.children ?? []) {
    const sig = child.signatures?.[0];
    members.push(
      sig
        ? `${esc(child.name)}${typeParamsHtml(sig.typeParameters)}${signatureTail(sig, false)}`
        : `${child.flags?.isReadonly ? "readonly " : ""}${esc(child.name)}${child.flags?.isOptional ? "?" : ""}: ${typeHtml(child.type, depth + 1)}`,
    );
  }
  for (const index of decl.indexSignatures ?? []) {
    const param = index.parameters?.[0];
    members.push(`[${esc(param?.name ?? "key")}: ${typeHtml(param?.type)}]: ${typeHtml(index.type)}`);
  }
  if (!members.length && decl.signatures?.length) {
    const sig = decl.signatures[0];
    return `${typeParamsHtml(sig.typeParameters)}${signatureTail(sig, true)}`;
  }
  if (!members.length) return "{}";
  const inline = `{ ${members.join("; ")} }`;
  if (plainLen(inline) <= 64 || depth > 1) return inline;
  const pad = "  ".repeat(depth + 1);
  return `{\n${members.map((m) => pad + m.replace(/\n/g, "\n" + pad)).join(";\n")};\n${"  ".repeat(depth)}}`;
}

// --- 4. Comments as HTML ----------------------------------------------------------------------------------------

function partsToMarkdown(parts = []) {
  return parts
    .map((part) => {
      if (part.kind === "inline-tag") {
        const label = part.text;
        if (typeof part.target === "number") {
          const place = where.get(part.target);
          return place ? `[\`${label}\`](${place.href})` : `\`${label}\``;
        }
        return typeof part.target === "string" ? `[${label}](${part.target})` : `\`${label}\``;
      }
      return part.text;
    })
    .join("");
}

function inlineMd(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = esc(out)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/** Just enough Markdown for JSDoc: paragraphs, lists, fenced code, inline code, bold, links. */
function markdown(md) {
  const blocks = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let para = [];
  let list = null;
  const flush = () => {
    if (para.length) blocks.push(`<p>${inlineMd(para.join(" "))}</p>`);
    para = [];
    if (list) blocks.push(`<ul>${list.map((item) => `<li>${inlineMd(item)}</li>`).join("")}</ul>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(`<pre class="code"><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (!line.trim()) {
      flush();
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (para.length) flush();
      (list ??= []).push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (list && /^\s+\S/.test(line)) {
      list[list.length - 1] += " " + line.trim();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks.join("\n");
}

const summaryHtml = (comment) => (comment?.summary?.length ? `<div class="prose">${markdown(partsToMarkdown(comment.summary))}</div>` : "");
const tagMd = (comment, tag) => comment?.blockTags?.filter((t) => t.tag === tag).map((t) => partsToMarkdown(t.content)) ?? [];

function tagsHtml(comment) {
  let out = "";
  for (const text of tagMd(comment, "@deprecated")) out += `<div class="note"><strong>Deprecated.</strong> ${markdown(text)}</div>`;
  for (const text of tagMd(comment, "@remarks")) out += `<div class="prose">${markdown(text)}</div>`;
  for (const text of tagMd(comment, "@example")) out += `<div class="prose"><p class="label">Example</p>${markdown(text)}</div>`;
  return out;
}

// --- 5. Reflections as HTML -------------------------------------------------------------------------------------

const code = (html) => `<pre class="sig"><code>${html}</code></pre>`;

function paramsTable(sig) {
  const params = (sig.parameters ?? []).filter((p) => p.comment?.summary?.length);
  const returns = tagMd(sig.comment, "@returns");
  let out = "";
  if (params.length) {
    out += `<dl class="params">${params
      .map((p) => `<dt><code>${esc(p.name)}</code></dt><dd>${markdown(partsToMarkdown(p.comment.summary))}</dd>`)
      .join("")}</dl>`;
  }
  if (returns.length) out += `<div class="prose"><p class="label">Returns</p>${markdown(returns.join("\n\n"))}</div>`;
  return out;
}

function functionSignatureHtml(name, sig, prefix = "") {
  return `${prefix}<span class="t-name">${esc(name)}</span>${typeParamsHtml(sig.typeParameters)}${signatureTail(sig, false)}`;
}

function memberHtml(parent, member) {
  const id = `${parent.name}.${member.name}`;
  const sigs = member.signatures ?? [];
  const accessor = member.getSignature || member.setSignature;
  let head;
  let body = "";
  if (sigs.length) {
    head = sigs.map((sig) => code(functionSignatureHtml(member.name, sig, member.flags?.isStatic ? "static " : ""))).join("");
    body = sigs.map((sig) => summaryHtml(sig.comment) + tagsHtml(sig.comment) + paramsTable(sig)).join("");
  } else if (accessor) {
    const type = (member.getSignature ?? member.setSignature).type ?? member.getSignature?.type;
    head = code(`${member.setSignature && !member.getSignature ? "set" : "get"} <span class="t-name">${esc(member.name)}</span>: ${typeHtml(type)}`);
    body = summaryHtml((member.getSignature ?? member.setSignature).comment);
  } else {
    head = code(
      `${member.flags?.isReadonly ? "readonly " : ""}<span class="t-name">${esc(member.name)}</span>${member.flags?.isOptional ? "?" : ""}: ${typeHtml(member.type)}`,
    );
    body = summaryHtml(member.comment) + tagsHtml(member.comment);
  }
  return `<div class="member" id="${esc(id)}">${head}${body}</div>`;
}

function symbolHtml(item) {
  const label = KIND_LABEL.get(item.kind) ?? "";
  let sigBlock = "";
  let body = "";
  let comment = item.comment;

  if (item.kind === K.Function) {
    const sigs = item.signatures ?? [];
    comment = sigs[0]?.comment ?? comment;
    sigBlock = sigs.map((sig) => code(`<span class="t-kw">function</span> ${functionSignatureHtml(item.name, sig)}`)).join("");
    body = sigs.map((sig) => (sig === sigs[0] ? "" : summaryHtml(sig.comment)) + paramsTable(sig)).join("");
  } else if (item.kind === K.TypeAlias) {
    sigBlock = code(`<span class="t-kw">type</span> <span class="t-name">${esc(item.name)}</span>${typeParamsHtml(item.typeParameters)} = ${typeHtml(item.type)}`);
    const decl = item.type?.type === "reflection" ? item.type.declaration : null;
    if (decl?.children?.length) body = `<div class="members">${decl.children.map((c) => memberHtml(item, c)).join("")}</div>`;
  } else if (item.kind === K.Variable) {
    sigBlock = code(`<span class="t-kw">const</span> <span class="t-name">${esc(item.name)}</span>: ${typeHtml(item.type)}`);
  } else if (item.kind === K.Interface || item.kind === K.Class) {
    const extendsList = (item.extendedTypes ?? []).map((t) => typeHtml(t)).join(", ");
    const implementsList = (item.implementedTypes ?? []).map((t) => typeHtml(t)).join(", ");
    sigBlock = code(
      `<span class="t-kw">${label}</span> <span class="t-name">${esc(item.name)}</span>${typeParamsHtml(item.typeParameters)}` +
        (extendsList ? ` <span class="t-kw">extends</span> ${extendsList}` : "") +
        (implementsList ? ` <span class="t-kw">implements</span> ${implementsList}` : ""),
    );
    const members = (item.children ?? []).filter((c) => !c.flags?.isPrivate && !c.flags?.isProtected);
    if (members.length) body = `<div class="members">${members.map((c) => memberHtml(item, c)).join("")}</div>`;
  }

  return `<section class="symbol" id="${esc(item.name)}">
  <h3><a class="anchor" href="#${esc(item.name)}">${esc(item.name)}</a> <span class="kind">${esc(label)}</span></h3>
  ${sigBlock}${summaryHtml(comment)}${tagsHtml(comment)}${body}
</section>`;
}

// --- 6. Pages ---------------------------------------------------------------------------------------------------

const GITHUB = "https://github.com/t1meshift/voxxy";

function grouped(mod) {
  return GROUPS.map(([kind, title]) => [title, (mod.node.children ?? []).filter((c) => c.kind === kind)]).filter(([, items]) => items.length);
}

function shell({ title, description, body, current }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#142b25" />
    <meta name="description" content="${esc(description)}" />
    <title>${esc(title)}</title>
    <link rel="icon" href="../voxxy-mark.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="../style.css" />
    <link rel="stylesheet" href="../api.css" />
  </head>
  <body>
    <a class="skip" href="#content">Skip to the reference</a>
    <header class="masthead wrap">
      <a class="wordmark" href="../" aria-label="voxxy home">
        <img class="brand-mark" src="../voxxy-mark.svg" width="34" height="34" alt="" />voxxy
      </a>
      <nav aria-label="Main">
        <a href="../#how">How it works</a>
        <a href="../#api">Examples</a>
        <a href="./" aria-current="${current ? "page" : "false"}">Reference</a>
        <a class="github-link" href="${GITHUB}">GitHub</a>
      </nav>
    </header>
    <div class="details">
      ${body}
      <footer class="wrap footer">
        <a class="wordmark" href="../">voxxy</a>
        <div class="footer-links">
          <a href="${GITHUB}">GitHub</a>
          <a href="../#api">Examples</a>
        </div>
      </footer>
    </div>
  </body>
</html>
`;
}

function sidebar(active) {
  const moduleLinks = modules
    .map((mod) => {
      const here = mod === active;
      const symbols = here
        ? `<div class="side-symbols">${grouped(mod)
            .map(([title, items]) => `<p class="side-group">${title}</p><ul>${items.map((i) => `<li><a href="#${esc(i.name)}">${esc(i.name)}</a></li>`).join("")}</ul>`)
            .join("")}</div>`
        : "";
      return `<li><a class="side-module" href="${mod.slug}.html"${here ? ' aria-current="page"' : ""}>${esc(mod.path)}</a>${symbols}</li>`;
    })
    .join("");
  return `<nav class="side" aria-label="Reference"><a class="side-home" href="./">Reference</a><ul class="side-modules">${moduleLinks}</ul></nav>`;
}

function modulePage(mod) {
  const sections = grouped(mod)
    .map(([title, items]) => `<h2 class="group">${title}</h2>${items.map(symbolHtml).join("\n")}`)
    .join("\n");
  const body = `<div class="doc wrap">
    ${sidebar(mod)}
    <main id="content" class="doc-main">
      <p class="crumb"><a href="./">Reference</a> <span class="crumb-version">v${esc(version)}</span></p>
      <h1>${esc(mod.path)}</h1>
      <p class="lede">${esc(mod.about)}</p>
      ${code(`<span class="t-kw">import</span> { … } <span class="t-kw">from</span> <span class="t-lit">"${esc(mod.path)}"</span>`)}
      ${sections}
    </main>
  </div>`;
  return shell({ title: `${mod.path} | voxxy reference`, description: mod.about, body, current: true });
}

function indexPage() {
  const byName = new Map();
  for (const mod of modules) for (const item of mod.node.children ?? []) if (!byName.has(item.name)) byName.set(item.name, { mod, item });
  const start = START_HERE.filter((name) => byName.has(name))
    .map((name) => {
      const { mod, item } = byName.get(name);
      const sig = item.signatures?.[0];
      const comment = sig?.comment ?? item.comment;
      const first = comment?.summary?.length ? inlineMd(partsToMarkdown(comment.summary).split(/\n\s*\n/)[0].replace(/\n/g, " ")) : "";
      return `<li><a href="${mod.slug}.html#${esc(name)}"><code>${esc(name)}</code></a><span>${first}</span></li>`;
    })
    .join("");
  const cards = modules
    .map((mod) => {
      const count = mod.node.children?.length ?? 0;
      return `<li><a class="card" href="${mod.slug}.html"><code>${esc(mod.path)}</code><span>${esc(mod.about)}</span><small>${count} export${count === 1 ? "" : "s"}</small></a></li>`;
    })
    .join("");
  const body = `<div class="wrap doc-index">
    <main id="content">
      <h1>Reference</h1>
      <p class="lede">Every public module of voxxy, generated from the source.${unstable ? " The API can still change before 1.0." : ""}</p>
      <p class="version">Version <code>${esc(version)}</code></p>
      <h2 class="group">Start here</h2>
      <ul class="start">${start}</ul>
      <h2 class="group">Modules</h2>
      <ul class="cards">${cards}</ul>
      <p class="more">A guided tour with examples is on the <a href="../#api">main page</a>; the long-form notes are in the <a href="${GITHUB}/blob/main/packages/voxxy/README.md">package README</a>.</p>
    </main>
  </div>`;
  return shell({ title: "Reference | voxxy", description: "API reference for voxxy, an on-device speech library for JavaScript apps.", body, current: true });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + "index.html", indexPage());
for (const mod of modules) writeFileSync(outDir + `${mod.slug}.html`, modulePage(mod));
console.log(`api reference: ${modules.length + 1} pages in ${outDir}`);
