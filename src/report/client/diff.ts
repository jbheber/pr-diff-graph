import { ColorSchemeType } from 'diff2html/lib-esm/types.js';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-base.js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES = { typescript, javascript, python, go, json, yaml, markdown, css, sql, bash, xml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

export type RenderDiff = (target: HTMLElement, patch: string) => void;

/**
 * Renders one file's patch into `target` with diff2html, which escapes the patch text; highlight.js
 * works on that escaped text and only adds its own spans.
 */
export const renderDiff: RenderDiff = (target, patch) => {
  new Diff2HtmlUI(
    target,
    patch,
    {
      outputFormat: 'line-by-line',
      drawFileList: false,
      colorScheme: ColorSchemeType.AUTO,
      highlight: true,
      synchronisedScroll: false,
      fileListToggle: false,
      fileContentToggle: false,
      stickyFileHeaders: false,
      smartSelection: false,
    },
    hljs,
  ).draw();
};
