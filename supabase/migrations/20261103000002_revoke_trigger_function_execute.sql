-- Trigger functions are never called directly; keep them out of the RPC surface.
revoke execute on function
  public.handle_new_user(), public.tg_doc_id_from_table(), public.tg_document_owner(),
  public.tg_form_share_doc(), public.tg_touch_document(), public.tg_widget_integrity(),
  public.tg_workspace_owner(), public.tg_touch_row(), public.tg_doc_tables_freeze()
from authenticated;
