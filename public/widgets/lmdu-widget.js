/*
 * LM Data Universe custom widget API, version 1.
 *
 * A custom widget is a web page shown in a sandboxed frame. Load this file,
 * then say what the widget needs:
 *
 *   lmdu.ready({
 *     requires: "read",                    // "none" | "read" | "full"
 *     columns: [                           // columns the editor maps in Widget options
 *       { name: "Title", type: "Text" },
 *       { name: "Amount", type: "Numeric,Int", optional: true },
 *       { name: "Tags", multiple: true },
 *     ],
 *   });
 *
 *   lmdu.onRecords(function (records) { ... });   // every record the widget shows
 *   lmdu.onRecord(function (record) { ... });     // the selected record (or the first)
 *   lmdu.onOptions(function (options) { ... });   // settings saved with lmdu.setOptions
 *
 * lmdu.mapping gives the labels of the mapped columns: { Title: "Name", Tags: ["A", "B"] }.
 * A record is { id, fields: {ColId: value}, display: {ColId: text}, <mapped name>: value }.
 * A mapped Reference column gives the linked record (and a Reference List
 * column a list of them), each in the same shape.
 *
 *   lmdu.setCursor(id)                 select a record (linked widgets follow)
 *   lmdu.setOptions({...})             save this widget's settings (editors only)
 *   lmdu.apply([...])                  full access: change records of the widget's table
 *       { op: "add", fields: {ColId: value} }
 *       { op: "update", id: 3, fields: {ColId: value} }
 *       { op: "remove", id: 3 }
 *   lmdu.fetchTable("Name")            full access: every record of another table
 * Both return promises.
 */
(function () {
  "use strict";
  var handlers = { records: [], record: [], options: [], init: [] };
  var state = { records: [], cursor: null, options: {}, access: "none", canEdit: false, table: null, mapping: {} };
  var pending = {};
  var seq = 0;

  function post(msg) {
    msg.lmdu = 1;
    window.parent.postMessage(msg, "*");
  }
  function emit(kind, value) {
    handlers[kind].forEach(function (fn) {
      try {
        fn(value, state);
      } catch (e) {
        console.error(e);
      }
    });
  }
  function current() {
    for (var i = 0; i < state.records.length; i++) if (state.records[i].id === state.cursor) return state.records[i];
    return state.records[0] || null;
  }
  function request(type, body) {
    return new Promise(function (resolve, reject) {
      var reqId = ++seq;
      pending[reqId] = { resolve: resolve, reject: reject };
      body.type = type;
      body.reqId = reqId;
      post(body);
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.lmdu !== 1) return;
    if (m.type === "init") {
      state.access = m.access;
      state.canEdit = !!m.canEdit;
      state.table = m.table;
      state.mapping = m.mapping || {};
      state.options = m.options || {};
      emit("init", m);
      emit("options", state.options);
      if (m.access === "none") {
        state.records = [];
        emit("records", []);
        emit("record", null);
      }
    } else if (m.type === "records") {
      state.records = m.records || [];
      emit("records", state.records);
      emit("record", current());
    } else if (m.type === "cursor") {
      if (state.cursor === m.id) return;
      state.cursor = m.id;
      emit("record", current());
    } else if (m.type === "reply" && pending[m.reqId]) {
      var p = pending[m.reqId];
      delete pending[m.reqId];
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || "Refused"));
    }
  });

  window.lmdu = {
    ready: function (o) {
      o = o || {};
      post({ type: "ready", requires: o.requires || "none", columns: o.columns || [] });
    },
    onRecords: function (fn) {
      handlers.records.push(fn);
    },
    onRecord: function (fn) {
      handlers.record.push(fn);
    },
    onOptions: function (fn) {
      handlers.options.push(fn);
    },
    onInit: function (fn) {
      handlers.init.push(fn);
    },
    setCursor: function (id) {
      state.cursor = id;
      post({ type: "setCursor", id: id });
      emit("record", current());
    },
    setOptions: function (options) {
      state.options = options;
      post({ type: "setOptions", options: options });
    },
    apply: function (actions) {
      return request("apply", { actions: actions });
    },
    fetchTable: function (table) {
      return request("fetchTable", { table: table });
    },
    get records() {
      return state.records;
    },
    get record() {
      return current();
    },
    get options() {
      return state.options;
    },
    get canEdit() {
      return state.canEdit;
    },
    /** Labels of the columns mapped to each declared name (a list for multiple). */
    get mapping() {
      return state.mapping;
    },
    /** Escapes text for HTML. */
    esc: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    },
  };
})();
