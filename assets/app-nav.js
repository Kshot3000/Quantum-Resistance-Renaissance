/* Shared app-switcher close-on-outside-click + copy helpers (optional). */
(function(){
  document.addEventListener('click', function(e){
    document.querySelectorAll('details.qmb-switch[open]').forEach(function(d){
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
})();
