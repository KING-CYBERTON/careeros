// CAREEROS: background tiles for the landing pages. A tile flips and takes a colour when the cursor passes over it.
(function () {
	var LIGHT = ["#dcf2df", "#bfe3c6", "#f3e3c2", "#e6dccb", "#cfe0ee", "#a9d6b3"];
	var DARK = ["#337344", "#4a8f5c", "#8a6a2a", "#3b3a32", "#2f5a7a", "#6fc082"];
	var hosts = [].slice.call(document.querySelectorAll("[data-tiles]"));
	function build(host) {
		var old = host.querySelector(":scope > .tiles");
		if (old) old.remove();
		var w = host.clientWidth;
		var h = host.clientHeight;
		if (!w || !h) return;
		var cols = Math.max(4, Math.round(w / 88));
		var size = w / cols;
		var rows = Math.ceil(h / size);
		var dark = host.classList.contains("ground-inverse");
		var pal = dark ? DARK : LIGHT;
		var layer = document.createElement("div");
		layer.className = "tiles";
		layer.setAttribute("aria-hidden", "true");
		layer.style.setProperty("--tile-cols", cols);
		layer.style.setProperty("--tile-size", size + "px");
		var frag = document.createDocumentFragment();
		for (var n = 0; n < cols * rows; n++) {
			var t = document.createElement("i");
			if (Math.random() < 0.07)
				t.style.setProperty(
					"--tile-rest",
					"color-mix(in oklab, " + pal[n % 5] + " " + (dark ? 35 : 45) + "%, transparent)",
				);
			frag.appendChild(t);
		}
		layer.appendChild(frag);
		host.insertBefore(layer, host.firstChild);
		host._t = { cols: cols, rows: rows, size: size, pal: pal, layer: layer, last: -1 };
	}
	function move(e) {
		if (e.pointerType === "touch") return;
		var host = e.currentTarget;
		var t = host._t;
		if (!t) return;
		var r = host.getBoundingClientRect();
		var c = Math.floor((e.clientX - r.left) / t.size);
		var row = Math.floor((e.clientY - r.top) / t.size);
		if (c < 0 || c >= t.cols || row < 0 || row >= t.rows) return;
		var idx = row * t.cols + c;
		if (idx === t.last) return;
		t.last = idx;
		var el = t.layer.children[idx];
		if (!el) return;
		el.style.setProperty("--tile-c", t.pal[Math.floor(Math.random() * t.pal.length)]);
		el.classList.add("is-lit");
		clearTimeout(el._off);
		el._off = setTimeout(function () {
			el.classList.remove("is-lit");
		}, 900);
	}
	function all() {
		hosts.forEach(build);
	}
	hosts.forEach(function (h) {
		h.addEventListener("pointermove", move);
		h.addEventListener("pointerleave", function () {
			if (h._t) h._t.last = -1;
		});
	});
	all();
	window.addEventListener("load", all);
	var rt;
	window.addEventListener("resize", function () {
		clearTimeout(rt);
		rt = setTimeout(all, 200);
	});
})();
