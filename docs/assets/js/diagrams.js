/* Size each embedded diagram's frame to the diagram it holds. The diagram
   scales to the frame's width, so a fixed height leaves a gap below wide
   diagrams. The pages are same-origin, so the frame's SVG can be measured. */
(function () {
  function fit(frame) {
    var doc, svg;
    try { doc = frame.contentDocument; } catch { return; }
    svg = doc && doc.querySelector("svg[viewBox]");
    if (!svg) return;
    var bottom = svg.getBoundingClientRect().bottom + 8;
    if (bottom > 120) frame.style.height = Math.ceil(bottom) + "px";
  }
  var frames = document.querySelectorAll(".ab-diagram iframe");
  frames.forEach(function (frame) {
    frame.addEventListener("load", function () { fit(frame); });
    if (frame.contentDocument && frame.contentDocument.readyState === "complete") fit(frame);
  });
  var t;
  window.addEventListener("resize", function () {
    clearTimeout(t);
    t = setTimeout(function () { frames.forEach(fit); }, 150);
  });
})();
