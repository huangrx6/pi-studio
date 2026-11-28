// Monaco renders only the visible lines. Enter edits through its focused input.
export async function replaceSourceText(editor, text) {
  await editor.focus();
  await editor.press('ControlOrMeta+a');
  await editor.page().keyboard.insertText(text);
}

export async function visibleSourceText(preview) {
  const lines = preview.locator('.view-lines .view-line');
  await lines.first().waitFor();
  return (await lines.allTextContents()).join('\n').replaceAll('\u00a0', ' ');
}

// Exercise the full-document copy action without touching the desktop clipboard.
export async function copyPreviewText(preview) {
  await preview.locator('.view-line').first().waitFor();
  await preview.getByRole('button', { name: '文件操作', exact: true }).click();
  return preview.page().getByRole('menuitem', { name: '复制文件内容', exact: true }).evaluate(async button => {
    const clipboard = navigator.clipboard;
    const previous = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
    let copied;
    Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async text => { copied = text; } });
    try {
      button.click();
      return copied;
    } finally {
      if (previous) Object.defineProperty(clipboard, 'writeText', previous);
      else delete clipboard.writeText;
    }
  });
}
