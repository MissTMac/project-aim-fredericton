// PDF.js viewer helper for Project AIM
// Uses the bundled PDF.js distribution at /pdfjs/web/viewer.html
// Keeps paths relative (no leading slash) so it works in subfolders and GitHub Pages project sites.

(function () {
  function buildPdfJsViewerUrl(fileUrl, opts) {
    opts = opts || {};
    const zoom = opts.zoom || "page-width";   // "page-width", "page-fit", number (e.g., 100)
    const page = opts.page || 1;
    const pagemode = opts.pagemode || "none"; // "none", "thumbs", "bookmarks"
    const view = opts.view || null;           // optional
    const aimTitle = opts.aimTitle || opts.title || null; // optional: sets browser tab title

    // viewer.html expects the PDF URL in a query string
    const viewerBase = "pdfjs/web/viewer.html";
    const params = new URLSearchParams();
    params.set("file", fileUrl);
    if (aimTitle) params.set("aimTitle", aimTitle);

    // PDF.js uses URL hash for view state
    const hashParts = [];
    if (page) hashParts.push("page=" + encodeURIComponent(page));
    if (zoom !== null && zoom !== undefined) hashParts.push("zoom=" + encodeURIComponent(zoom));
    if (pagemode) hashParts.push("pagemode=" + encodeURIComponent(pagemode));
    if (view) hashParts.push("view=" + encodeURIComponent(view));

    const hash = hashParts.length ? ("#" + hashParts.join("&")) : "";
    return viewerBase + "?" + params.toString() + hash;
  }

  // expose globally for app.js
  window.AIM_PDF = window.AIM_PDF || {};
  window.AIM_PDF.buildPdfJsViewerUrl = buildPdfJsViewerUrl;
})();
