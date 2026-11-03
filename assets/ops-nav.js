/* Shared /ops top-nav.
   One source of truth for the operator header.
   Mounted into any <nav class="ops-site-nav"> on the page.
   Current section/page is marked active from location.pathname. */
(function () {
  "use strict";

  var SECTIONS = [
    { label: "Today", href: "/ops" },
    { label: "Operations", children: [
      { label: "Updates",     href: "/ops/updates"  },
      { label: "Time Off",    href: "/ops/time-off" },
      { label: "Stops",       href: "/ops/stops"    },
      { label: "Shifts",      href: "/ops/shifts"   },
      { label: "People",      href: "/ops/people"   },
      { label: "Store Comms", href: "/ops/store"    }
    ]},
    { label: "Money", children: [
      { label: "Revenue",  href: "/ops/revenue"  },
      { label: "Payments", href: "/ops/payments" }
    ]},
    { label: "Growth", children: [
      { label: "Prospecting", href: "/ops/prospecting" },
      { label: "Onboard",     href: "/ops/onboard"     },
      { label: "Invite",      href: "/ops/invite"      },
      { label: "Print Kits",  href: "/ops/print-kits"  }
    ]},
    { label: "Plan", children: [
      { label: "Plan",      href: "/ops/plan"      },
      { label: "Standings", href: "/ops/standings" }
    ]}
  ];

  function matches(href, path) {
    if (href === "/ops") return path === "/ops" || path === "/ops/";
    return path === href || path.indexOf(href + "/") === 0;
  }

  function render(path) {
    var html = "";
    for (var i = 0; i < SECTIONS.length; i++) {
      var s = SECTIONS[i];
      if (s.children) {
        var activeChild = s.children.some(function (c) { return matches(c.href, path); });
        var subs = s.children.map(function (c) {
          var cls = "ops-nav-sub-link" + (matches(c.href, path) ? " is-active" : "");
          return '<a href="' + c.href + '" class="' + cls + '">' + c.label + '</a>';
        }).join("");
        var groupCls = "ops-nav-group" + (activeChild ? " is-active" : "");
        var btnCls = "nav-link ops-nav-toggle" + (activeChild ? " is-active" : "");
        html +=
          '<div class="' + groupCls + '">' +
            '<button type="button" class="' + btnCls + '" aria-haspopup="true" aria-expanded="false">' +
              s.label + '<span class="ops-nav-caret" aria-hidden="true">▾</span>' +
            '</button>' +
            '<div class="ops-nav-dropdown" role="menu">' + subs + '</div>' +
          '</div>';
      } else {
        var topCls = "nav-link" + (matches(s.href, path) ? " is-active" : "");
        html += '<a href="' + s.href + '" class="' + topCls + '">' + s.label + '</a>';
      }
    }
    return html;
  }

  function injectStyles() {
    if (document.getElementById("ops-nav-styles")) return;
    var css =
      ".ops-nav-group{position:relative;display:inline-flex;align-items:center;}" +
      ".ops-nav-toggle{background:transparent;border:0;cursor:pointer;font:inherit;color:inherit;letter-spacing:inherit;text-transform:inherit;display:inline-flex;align-items:center;gap:6px;}" +
      ".ops-nav-caret{font-size:9px;opacity:0.7;line-height:1;}" +
      ".ops-nav-dropdown{display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:50;min-width:200px;background:var(--bg-2,#1a1d22);border:1px solid var(--line,#2a2d32);border-radius:10px;padding:6px;box-shadow:0 16px 36px -14px rgba(0,0,0,0.55);flex-direction:column;gap:1px;}" +
      ".ops-nav-group.is-open .ops-nav-dropdown{display:flex;}" +
      ".ops-nav-sub-link{display:block;padding:8px 14px;border-radius:6px;color:var(--ink-2,#a0a4a9);text-decoration:none;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;font-family:var(--display,inherit);white-space:nowrap;}" +
      ".ops-nav-sub-link:hover{color:var(--ink,#e8e9ea);background:rgba(255,255,255,0.05);}" +
      ".ops-nav-sub-link.is-active{color:var(--accent,#d4b662);background:rgba(212,182,98,0.1);}" +
      "@media (max-width:720px){.ops-nav-dropdown{right:0;left:auto;}}";
    var el = document.createElement("style");
    el.id = "ops-nav-styles";
    el.textContent = css;
    document.head.appendChild(el);
  }

  function wireDropdowns(nav) {
    nav.addEventListener("click", function (e) {
      var toggle = e.target.closest(".ops-nav-toggle");
      if (!toggle) return;
      e.preventDefault();
      var group = toggle.closest(".ops-nav-group");
      var open = group.classList.contains("is-open");
      nav.querySelectorAll(".ops-nav-group.is-open").forEach(function (g) {
        g.classList.remove("is-open");
        var btn = g.querySelector(".ops-nav-toggle");
        if (btn) btn.setAttribute("aria-expanded", "false");
      });
      if (!open) {
        group.classList.add("is-open");
        toggle.setAttribute("aria-expanded", "true");
      }
    });
    document.addEventListener("click", function (e) {
      if (e.target.closest(".ops-nav-group")) return;
      nav.querySelectorAll(".ops-nav-group.is-open").forEach(function (g) {
        g.classList.remove("is-open");
        var btn = g.querySelector(".ops-nav-toggle");
        if (btn) btn.setAttribute("aria-expanded", "false");
      });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      nav.querySelectorAll(".ops-nav-group.is-open").forEach(function (g) {
        g.classList.remove("is-open");
        var btn = g.querySelector(".ops-nav-toggle");
        if (btn) btn.setAttribute("aria-expanded", "false");
      });
    });
  }

  function mount() {
    var nav = document.querySelector("nav.ops-site-nav");
    if (!nav) return;
    injectStyles();
    nav.innerHTML = render(location.pathname);
    wireDropdowns(nav);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
