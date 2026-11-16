import speak from "../examples/speak.html?raw";
import transcribe from "../examples/transcribe.html?raw";

const examples = { speak, transcribe };
type Example = keyof typeof examples;

const navigation = document.querySelector<HTMLElement>("#example-navigation")!;
const buttons = navigation.querySelectorAll<HTMLButtonElement>("button");
const source = document.querySelector<HTMLElement>("#example-source")!;
const panel = document.querySelector<HTMLElement>("#example-panel")!;
const run = document.querySelector<HTMLAnchorElement>("#run-example")!;
const copy = document.querySelector<HTMLButtonElement>("#copy-example")!;
const status = document.querySelector<HTMLElement>("#copy-status")!;

function showExample(example: Example): void {
  source.textContent = examples[example];
  run.href = `./examples/${example}.html`;
  source.parentElement!.scrollTo(0, 0);
  status.textContent = "";
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.value === example));
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => showExample(button.value as Example));
}

copy.addEventListener("click", async () => {
  const text = source.textContent!;
  try {
    await navigator.clipboard.writeText(text);
    if (source.textContent === text) status.textContent = "Copied.";
  } catch {
    if (source.textContent !== text) return;
    const range = document.createRange();
    range.selectNodeContents(source);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    status.textContent = "Code selected. Copy it with your keyboard.";
  }
});

showExample("speak");
navigation.hidden = false;
panel.hidden = false;
