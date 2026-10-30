import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ACCELERATOR_URL,
  acceleratorLink,
} from '../nsdeploy_service/ui/assets/js/components/acceleratorLink.js';

test('accelerator link uses the approved URL and registered product name', () => {
  const html = acceleratorLink();
  assert.equal(ACCELERATOR_URL, 'https://neuro-san.evolution.ml/multiAgentAccelerator');
  assert.match(html, /Create\/edit agentic systems in/);
  assert.match(html, /Cognizant Neuro&reg; AI Multi-Agent Accelerator/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('all three requested UI surfaces render the shared link', () => {
  const paths = [
    '../nsdeploy_service/ui/assets/js/views/deploy.js',
    '../nsdeploy_service/ui/assets/js/views/networks.js',
    '../nsdeploy_service/ui/assets/js/components/linkPromptModal.js',
  ];
  for (const path of paths) {
    const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /\$\{acceleratorLink\(\)\}/, path);
  }
});
