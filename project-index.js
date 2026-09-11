'use strict';

(() => {
  const dialog = document.getElementById('project-index');
  const grid = dialog.querySelector('.index-grid');
  const projects = [...document.querySelectorAll('.section')];
  const posters = { 'project-2': 'QuickStep.png', 'project-7': 'Treb.png' };
  document.getElementById('index-count').textContent = projects.length;
  document.getElementById('hero-project-count').textContent = projects.length;

  projects.forEach((project, index) => {
    const title = project.querySelector('.project-title').cloneNode(true);
    title.querySelectorAll('br').forEach(br => br.replaceWith(' '));
    const card = document.createElement('a');
    card.className = 'index-card';
    card.href = `#${project.id}`;
    const preview = document.createElement('div');
    preview.className = 'index-image';
    const photo = project.querySelector('.section-right img');
    const image = document.createElement('img');
    image.src = photo ? photo.getAttribute('src') : posters[project.id];
    image.alt = '';
    image.loading = 'lazy';
    preview.append(image);
    const label = document.createElement('div');
    label.className = 'index-card-title';
    const number = document.createElement('span');
    number.textContent = String(index + 1).padStart(2, '0');
    label.append(number, document.createTextNode(title.textContent.trim()));
    card.append(preview, label);
    card.addEventListener('click', event => {
      event.preventDefault();
      dialog.close();
      project.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    });
    grid.append(card);
  });

  document.querySelectorAll('[data-open-project-index]').forEach(button => {
    button.addEventListener('click', () => {
      document.body.dataset.projectIndexUsed = 'true';
      document.getElementById('mobile-nav')?.classList.remove('active');
      dialog.showModal();
    });
  });
  dialog.querySelector('.index-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
})();
