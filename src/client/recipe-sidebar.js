// ── Recipe sidebar — objective history ──
import state from './state.js';
import { escapeAttr, saveDraft, getObjectiveDraftKey } from './utils.js';

function reload() {
  document.dispatchEvent(new Event('tiptask:reload'));
}

export async function loadRecipes() {
  try {
    const res = await fetch('/api/recipes');
    const data = await res.json();
    state.recipesCache = data.recipes || [];
  } catch {
    state.recipesCache = [];
  }
  return state.recipesCache;
}

export async function saveRecipe(text) {
  try {
    await fetch('/api/recipes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    state.recipesCache = null; // invalidate cache
  } catch { /* best-effort */ }
}

export function showRecipesModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="recipes-modal">
      <h3>Objective History</h3>
      <input type="text" class="recipes-search" placeholder="Search objectives..." autofocus />
      <div class="recipes-list">
        <div class="recipes-list-empty">Loading...</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  loadRecipes().then(recipes => {
    const list = overlay.querySelector('.recipes-list');
    if (!recipes.length) {
      list.innerHTML = '<div class="recipes-list-empty">No saved objectives yet.</div>';
      return;
    }
    list.innerHTML = recipes.map(r => {
      const preview = r.content.split('\n')[0].slice(0, 120);
      return `
        <div class="recipe-item" data-filename="${escapeAttr(r.filename)}">
          <div class="recipe-item-name">${escapeAttr(r.filename)}</div>
          <div class="recipe-item-preview">${escapeAttr(preview)}</div>
        </div>`;
    }).join('');

    const searchInput = overlay.querySelector('.recipes-search');
    searchInput.addEventListener('input', () => {
      const needle = searchInput.value.toLowerCase();
      const items = list.querySelectorAll('.recipe-item');
      let visible = 0;
      items.forEach(item => {
        const fn = item.dataset.filename;
        const recipe = recipes.find(r => r.filename === fn);
        const haystack = recipe ? recipe.content.toLowerCase() : '';
        const match = !needle || haystack.includes(needle);
        item.style.display = match ? '' : 'none';
        if (match) visible++;
      });
      let noMatch = list.querySelector('.recipes-no-match');
      if (visible === 0 && needle) {
        if (!noMatch) {
          noMatch = document.createElement('div');
          noMatch.className = 'recipes-list-empty recipes-no-match';
          noMatch.textContent = 'No matches found.';
          list.appendChild(noMatch);
        }
      } else if (noMatch) {
        noMatch.remove();
      }
    });

    list.querySelectorAll('.recipe-item').forEach(item => {
      item.addEventListener('click', () => {
        const fn = item.dataset.filename;
        const recipe = recipes.find(r => r.filename === fn);
        if (recipe) {
          // Save draft so it persists and shows "Clear Draft" button
          saveDraft(getObjectiveDraftKey(), { text: recipe.content });

          // Ensure we're on the objective tab (textarea only exists there)
          if (state.activeTab !== 'objective') {
            state.activeTab = 'objective';
            state.pendingScrollTop = true; // navigating away → reset to top
          }

          // Close modal, re-render, then populate textarea
          overlay.remove();
          reload();

          // After render, populate the textarea and trigger auto-resize
          const textarea = document.getElementById('chat-input');
          if (textarea) {
            textarea.value = recipe.content;
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, window.innerHeight * 0.5) + 'px';
            saveDraft(getObjectiveDraftKey(), { text: recipe.content, height: textarea.style.height });
            textarea.focus();
          }
        } else {
          overlay.remove();
        }
      });
    });
  });
}
