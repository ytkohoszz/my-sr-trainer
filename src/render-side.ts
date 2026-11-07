import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import { extractImageEmbeds } from "./media";

function missingImage(target: string): HTMLElement {
  const placeholder = document.createElement("span");
  placeholder.className = "my-sr-image-missing";
  placeholder.textContent = `Изображение не найдено: ${target}`;
  return placeholder;
}

function replaceTextMarker(
  root: HTMLElement,
  marker: string,
  replacement: Node
): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.includes(marker)) {
      const text = node.textContent ?? "";
      const parts = text.split(marker);
      const fragment = document.createDocumentFragment();
      parts.forEach((part, index) => {
        if (part) fragment.append(document.createTextNode(part));
        if (index < parts.length - 1) fragment.append(replacement);
      });
      node.parentNode?.replaceChild(fragment, node);
      return true;
    }
  }
  return false;
}

export async function renderStudySide(
  app: App,
  raw: string,
  sourcePath: string,
  parent: Component
): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.className = "my-sr-side-content";
  const renderComponent = parent.addChild(new Component());
  const embeds = extractImageEmbeds(raw).filter(
    (embed) => !/^https?:\/\//i.test(embed.target)
  );
  let markdown = raw;

  embeds.forEach((embed, index) => {
    const file = app.metadataCache.getFirstLinkpathDest(
      embed.target,
      sourcePath
    );
    if (!(file instanceof TFile)) {
      const marker = `SRMISSINGIMAGE${index}TOKEN`;
      markdown = markdown.replace(embed.fullMatch, marker);
      replaceTextMarker(container, marker, missingImage(embed.target));
    }
  });

  try {
    await MarkdownRenderer.render(
      app,
      markdown,
      container,
      sourcePath,
      renderComponent
    );
  } catch (error) {
    console.error("Не удалось отобразить сторону учебной карточки.", error);
    container.empty();
    container.setText(raw);
    return container;
  }

  embeds.forEach((embed, index) => {
    const file = app.metadataCache.getFirstLinkpathDest(
      embed.target,
      sourcePath
    );
    if (!(file instanceof TFile)) {
      const marker = `SRMISSINGIMAGE${index}TOKEN`;
      replaceTextMarker(container, marker, missingImage(embed.target));
    }
  });

  const overlay = document.createElement("div");
  overlay.className = "my-sr-image-overlay";
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("role", "dialog");
  renderComponent.registerDomEvent(overlay, "click", () => overlay.remove());
  renderComponent.register(() => overlay.remove());
  renderComponent.registerDomEvent(document, "keydown", (event) => {
    if (event.key === "Escape" && overlay.isConnected) {
      event.preventDefault();
      event.stopPropagation();
      overlay.remove();
    }
  });

  renderComponent.registerDomEvent(
    container,
    "error",
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      image.replaceWith(
        missingImage(image.alt || image.getAttribute("src") || "изображение")
      );
    },
    true
  );

  renderComponent.registerDomEvent(container, "click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const preview = document.createElement("img");
    preview.src = target.src;
    preview.alt = target.alt;
    overlay.replaceChildren(preview);
    document.body.append(overlay);
  });

  return container;
}
