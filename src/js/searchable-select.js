(function () {
  function enhance(select) {
    if (!select || select.dataset.comboEnhanced || select.multiple) return;
    select.dataset.comboEnhanced = '1';

    var wrapper = document.createElement('div');
    wrapper.className = 'combo-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    select.classList.add('combo-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    wrapper.hidden = select.hidden;

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'combo-input';
    input.placeholder = select.getAttribute('data-placeholder') || 'Search or select...';
    input.autocomplete = 'off';
    input.disabled = select.disabled;
    if (select.required) input.dataset.required = '1';
    wrapper.appendChild(input);

    var list = document.createElement('ul');
    list.className = 'combo-list';
    list.hidden = true;
    wrapper.appendChild(list);

    var scrollParent = null;
    var isPortaled = false;

    function findScrollParent(node) {
  var el = node.parentElement;
  while (el && el !== document.body) {
    var style = getComputedStyle(el);
    var overflowsY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    var overflowsX = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    if (overflowsY || overflowsX) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

 function positionPortaledList() {
  var rect = wrapper.getBoundingClientRect();
  list.style.left = rect.left + 'px';
  list.style.top = (rect.bottom + 4) + 'px';
  list.style.minWidth = rect.width + 'px';
  list.style.width = 'max-content';

  requestAnimationFrame(function () {
    var listRect = list.getBoundingClientRect();
    var viewportWidth = document.documentElement.clientWidth;
    if (listRect.right > viewportWidth - 8) {
      list.style.left = Math.max(8, viewportWidth - listRect.width - 8) + 'px';
    }
  });
}

   function nearestOpenDialog(node) {
  return node.closest && node.closest('dialog[open]');
}

function openList() {
  const hostDialog = nearestOpenDialog(wrapper);
  scrollParent = findScrollParent(wrapper);
  if (scrollParent) {
    isPortaled = true;
    (hostDialog || document.body).appendChild(list); 
    list.classList.add('combo-list-portaled');
    positionPortaledList();
    window.addEventListener('scroll', positionPortaledList, true);
    window.addEventListener('resize', positionPortaledList);
  } else {
    isPortaled = false;
  }
  list.hidden = false;
}
    function closeList() {
      list.hidden = true;
      if (isPortaled) {
        window.removeEventListener('scroll', positionPortaledList, true);
        window.removeEventListener('resize', positionPortaledList);
        list.classList.remove('combo-list-portaled');
        wrapper.appendChild(list); 
        isPortaled = false;
      }
    }

    function optionsList() { return Array.prototype.slice.call(select.options); }

    function labelFor(value) {
      var match = optionsList().filter(function (o) { return o.value === value; })[0];
      return match ? match.textContent.trim() : '';
    }

    function renderList(filterText) {
      var q = (filterText || '').trim().toLowerCase();
      var opts = optionsList().filter(function (o) {
        return !q || o.textContent.toLowerCase().indexOf(q) !== -1;
      });
      if (!opts.length) {
        list.innerHTML = '<li class="combo-empty">No matching results</li>';
      } else {
        list.innerHTML = opts.map(function (o) {
          var active = o.value === select.value ? ' active' : '';
          return '<li data-value="' + o.value.replace(/"/g, '&quot;') + '" class="combo-option' + active + '">' + o.textContent + '</li>';
        }).join('');
      }
      openList();
      if (isPortaled) positionPortaledList();
    }

    function selectValue(value) {
      select.value = value;
      closeList();
    }

    input.addEventListener('focus', function () {
  if (input.disabled) return;
  input.value = '';       
  renderList('');
});
   input.addEventListener('click', function () {
  if (input.disabled) return;
  if (list.hidden) {
    input.value = '';
    renderList('');
  } else {
    renderList(input.value);
  }
});
input.addEventListener('blur', function () {
  setTimeout(function () {
    if (list.hidden) {
      input.value = labelFor(select.value);
    }
  }, 150);
});
    input.addEventListener('input', function () { renderList(input.value); });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeList(); input.blur(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        var first = list.querySelector('li[data-value]');
        if (first) selectValue(first.dataset.value);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (list.hidden) { renderList(input.value); return; }
        var items = Array.prototype.slice.call(list.querySelectorAll('li[data-value]'));
        if (!items.length) return;
        var idx = items.findIndex(function (li) { return li.classList.contains('combo-focus'); });
        items.forEach(function (li) { li.classList.remove('combo-focus'); });
        idx = event.key === 'ArrowDown' ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
        items[idx].classList.add('combo-focus');
        items[idx].scrollIntoView({ block: 'nearest' });
      }
    });

    list.addEventListener('mousedown', function (event) {
      var li = event.target.closest('li[data-value]');
      if (!li) return;
      event.preventDefault();
      selectValue(li.dataset.value);
      input.blur();
    });

   document.addEventListener('click', function (event) {
  if (wrapper.contains(event.target) || list.contains(event.target)) return;
  closeList();
  input.value = labelFor(select.value);   
});


    var nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: function () { return nativeDescriptor.get.call(select); },
      set: function (newValue) {
        nativeDescriptor.set.call(select, newValue);
        input.value = labelFor(select.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });

    input.value = labelFor(select.value);
    select.refreshSearchableValue = function () {
      input.value = labelFor(select.value);
      renderList('');
      closeList();
    };
    if (select.form) select.form.addEventListener('reset', function () {
      setTimeout(function () { input.value = labelFor(select.value); closeList(); }, 0);
    });

    new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'attributes' && record.attributeName === 'hidden') wrapper.hidden = select.hidden;
        if (record.type === 'attributes' && record.attributeName === 'disabled') input.disabled = select.disabled;
      });
      input.value = labelFor(select.value);
    }).observe(select, { childList: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
  }

  function enhanceWithin(node) {
    if (node.matches && node.matches('select')) enhance(node);
    if (node.querySelectorAll) node.querySelectorAll('select').forEach(enhance);
  }

  function init() {
    document.querySelectorAll('select').forEach(enhance);
    new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (!(node instanceof Element)) return;
          enhanceWithin(node);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
