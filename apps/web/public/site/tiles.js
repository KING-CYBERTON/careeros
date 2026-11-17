// CAREEROS: background tiles for the marketing pages. The grid is drawn by CSS; this script adds a few tinted tiles
// at rest and, where there is a cursor, one tile that flips and takes a colour in each cell the cursor passes over.
// Only those tiles are elements, so the page stays light on phones.
(function () {
	var LIGHT = ["#dcf2df", "#bfe3c6", "#f3e3c2", "#e6dccb", "#cfe0ee", "#a9d6b3"];
	var DARK = ["#337344", "#4a8f5c", "#8a6a2a", "#3b3a32", "#2f5a7a", "#6fc082"];
	var hosts = [].slice.call(document.querySelectorAll("[data-tiles]"));

	function tile(layer, column, row, colour, name) {
		var element = document.createElement("i");
		element.className = name;
		element.style.setProperty("--c", column);
		element.style.setProperty("--r", row);
		element.style.setProperty("--tile-c", colour);
		layer.appendChild(element);
		return element;
	}

	function build(host) {
		var width = host.clientWidth;
		var height = host.clientHeight;
		if (!width || !height) return;
		var state = host._tiles;
		if (state && state.width === width && state.height === height) return;
		if (state) state.layer.remove();

		var columns = Math.max(4, Math.round(width / 88));
		var size = width / columns;
		var rows = Math.ceil(height / size);
		var dark = host.classList.contains("ground-inverse");
		var palette = dark ? DARK : LIGHT;
		var layer = document.createElement("div");
		layer.className = "tiles";
		layer.setAttribute("aria-hidden", "true");
		layer.style.setProperty("--tile-size", size + "px");

		var resting = Math.round(columns * rows * 0.07);
		for (var n = 0; n < resting; n++) {
			var colour = "color-mix(in oklab, " + palette[n % 5] + " " + (dark ? 35 : 45) + "%, transparent)";
			tile(layer, Math.floor(Math.random() * columns), Math.floor(Math.random() * rows), colour, "is-rest");
		}
		host.insertBefore(layer, host.firstChild);
		host._tiles = {
			width: width,
			height: height,
			columns: columns,
			rows: rows,
			size: size,
			palette: palette,
			layer: layer,
			last: -1,
		};
	}

	function move(event) {
		if (event.pointerType === "touch") return;
		var host = event.currentTarget;
		var state = host._tiles;
		if (!state) return;
		var box = host.getBoundingClientRect();
		var column = Math.floor((event.clientX - box.left) / state.size);
		var row = Math.floor((event.clientY - box.top) / state.size);
		if (column < 0 || column >= state.columns || row < 0 || row >= state.rows) return;
		var index = row * state.columns + column;
		if (index === state.last) return;
		state.last = index;
		var colour = state.palette[Math.floor(Math.random() * state.palette.length)];
		var lit = tile(state.layer, column, row, colour, "is-lit");
		lit.addEventListener("animationend", function () {
			lit.remove();
		});
	}

	function buildAll() {
		hosts.forEach(build);
	}

	hosts.forEach(function (host) {
		host.addEventListener("pointermove", move);
		host.addEventListener("pointerleave", function () {
			if (host._tiles) host._tiles.last = -1;
		});
	});
	// After the page has loaded and is idle: the tiles are decoration and must not delay the content.
	var later =
		window.requestIdleCallback ||
		function (run) {
			return setTimeout(run, 200);
		};
	if (document.readyState === "complete") later(buildAll);
	else
		window.addEventListener("load", function () {
			later(buildAll);
		});
	var timer;
	window.addEventListener("resize", function () {
		clearTimeout(timer);
		timer = setTimeout(buildAll, 200);
	});
})();
