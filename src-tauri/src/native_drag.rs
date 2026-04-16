use std::{
    ffi::{c_char, CStr},
    path::PathBuf,
    sync::OnceLock,
};

#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::{
    ffi::OsStr,
    fs,
    mem::{size_of, ManuallyDrop},
    os::windows::ffi::OsStrExt,
    ptr,
    sync::Mutex,
};

use tauri::{AppHandle, Window};
#[cfg(target_os = "windows")]
use windows_core::{implement, BOOL, Error as WindowsError, HRESULT};
#[cfg(target_os = "windows")]
use windows::{
    Win32::{
        Foundation::{
            DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
            DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, DV_E_TYMED, E_FAIL, E_NOTIMPL,
            E_POINTER, OLE_E_ADVISENOTSUPPORTED, S_FALSE, S_OK,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::{
            Com::{
                DATADIR_GET, FORMATETC, IAdviseSink, IDataObject, IDataObject_Impl,
                IEnumFORMATETC, IEnumFORMATETC_Impl, IEnumSTATDATA, STGMEDIUM, STGMEDIUM_0,
                TYMED_HGLOBAL, TYMED_ISTREAM,
            },
            DataExchange::RegisterClipboardFormatW,
            Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
            Ole::{DoDragDrop, DROPEFFECT, DROPEFFECT_COPY, IDropSource, IDropSource_Impl},
            SystemServices::{MODIFIERKEYS_FLAGS, MK_LBUTTON},
        },
        UI::Shell::{
            CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES, FD_PROGRESSUI, FD_UNICODE,
            FILEDESCRIPTORW, SHCreateMemStream,
        },
    },
};

use crate::{
    file_ops,
    models::{RemoteDragEntry, SessionDefinition},
};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "windows")]
static WINDOWS_DRAG_FORMATS: OnceLock<(u16, u16)> = OnceLock::new();

#[cfg(target_os = "macos")]
extern "C" {
    fn openxterm_start_file_promise_drag_v2(
        ns_window: *mut c_void,
        session_json: *const u8,
        session_json_len: usize,
        entries_json: *const u8,
        entries_json_len: usize,
        client_x: f64,
        client_y: f64,
    ) -> bool;
}

pub fn start_native_file_drag(
    app: &AppHandle,
    window: &Window,
    session: &SessionDefinition,
    remote_path: &str,
    file_name: &str,
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    let _ = APP_HANDLE.set(app.clone());

    start_native_entries_drag(
        app,
        window,
        session,
        &[RemoteDragEntry {
            remote_path: remote_path.to_string(),
            file_name: file_name.to_string(),
            kind: "file".into(),
            transfer_id: None,
        }],
        client_x,
        client_y,
    )
}

pub fn start_native_entries_drag(
    app: &AppHandle,
    window: &Window,
    session: &SessionDefinition,
    entries: &[RemoteDragEntry],
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    let _ = APP_HANDLE.set(app.clone());

    start_native_file_drag_impl(app, window, session, entries, client_x, client_y)
}

#[cfg(target_os = "macos")]
fn start_native_file_drag_impl(
    _app: &AppHandle,
    window: &Window,
    session: &SessionDefinition,
    entries: &[RemoteDragEntry],
    client_x: f64,
    client_y: f64,
) -> Result<bool, String> {
    if entries.is_empty() {
        return Ok(false);
    }

    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to get NSWindow: {error}"))?;
    let session_json = serde_json::to_string(session)
        .map_err(|error| format!("failed to encode session for native drag: {error}"))?;
    let entries = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| NativePromiseEntry {
            remote_path: entry.remote_path.clone(),
            file_name: entry.file_name.clone(),
            kind: entry.kind.clone(),
            transfer_id: entry
                .transfer_id
                .clone()
                .unwrap_or_else(|| format!("native-drag-{}-{index}", uuid_like_stamp())),
        })
        .collect::<Vec<_>>();
    let entries_json = serde_json::to_string(&entries)
        .map_err(|error| format!("failed to encode drag entries: {error}"))?;

    let started = unsafe {
        openxterm_start_file_promise_drag_v2(
            ns_window,
            session_json.as_bytes().as_ptr(),
            session_json.len(),
            entries_json.as_bytes().as_ptr(),
            entries_json.len(),
            client_x,
            client_y,
        )
    };

    Ok(started)
}

#[cfg(target_os = "windows")]
fn start_native_file_drag_impl(
    app: &AppHandle,
    _window: &Window,
    session: &SessionDefinition,
    entries: &[RemoteDragEntry],
    _client_x: f64,
    _client_y: f64,
) -> Result<bool, String> {
    if entries.is_empty() {
        return Ok(false);
    }

    let drag_entries = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            if entry.kind != "file" {
                return Err("Windows drag-out currently exports files only.".to_string());
            }

            Ok(WindowsVirtualDragEntry {
                remote_path: entry.remote_path.clone(),
                file_name: entry.file_name.clone(),
                transfer_id: entry
                    .transfer_id
                    .clone()
                    .unwrap_or_else(|| format!("native-drag-{}-{index}", uuid_like_stamp())),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let data_object: IDataObject =
        WindowsVirtualFileDataObject::new(app.clone(), session.clone(), drag_entries).into();
    let drop_source: IDropSource = WindowsDropSource.into();
    let mut effect = DROPEFFECT(0);
    let result = unsafe { DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect) };

    if result == DRAGDROP_S_DROP || result == DRAGDROP_S_CANCEL || result == S_OK {
        Ok(true)
    } else {
        Err(format!(
            "failed to start native Windows drag-out: {}",
            WindowsError::from(result)
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn start_native_file_drag_impl(
    _app: &AppHandle,
    _window: &Window,
    _session: &SessionDefinition,
    _entries: &[RemoteDragEntry],
    _client_x: f64,
    _client_y: f64,
) -> Result<bool, String> {
    Ok(false)
}

#[no_mangle]
pub extern "C" fn openxterm_native_drag_write_file(
    session_json: *const c_char,
    remote_path: *const c_char,
    destination_path: *const c_char,
    transfer_id: *const c_char,
    file_kind: *const c_char,
) -> i32 {
    match write_promised_file(
        session_json,
        remote_path,
        destination_path,
        transfer_id,
        file_kind,
    ) {
        Ok(()) => 0,
        Err(error) => {
            log::error!("native drag promised-file write failed: {error}");
            1
        }
    }
}

fn write_promised_file(
    session_json: *const c_char,
    remote_path: *const c_char,
    destination_path: *const c_char,
    transfer_id: *const c_char,
    file_kind: *const c_char,
) -> Result<(), String> {
    let app = APP_HANDLE
        .get()
        .ok_or_else(|| "OpenXTerm app handle is not initialized for native drag".to_string())?;
    let session_json = c_string(session_json, "session json")?;
    let remote_path = c_string(remote_path, "remote path")?;
    let destination_path = c_string(destination_path, "destination path")?;
    let transfer_id = c_string(transfer_id, "transfer id")?;
    let file_kind = c_string(file_kind, "file kind")?;
    let session = serde_json::from_str::<SessionDefinition>(&session_json)
        .map_err(|error| format!("failed to decode native drag session: {error}"))?;

    file_ops::download_remote_entry_to_path(
        app,
        &session,
        &remote_path,
        &remote_file_name(&remote_path),
        &PathBuf::from(destination_path),
        &file_kind,
        "drag-export",
        Some(transfer_id),
    )
    .map(|_| ())
}

#[cfg(target_os = "macos")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePromiseEntry {
    remote_path: String,
    file_name: String,
    kind: String,
    transfer_id: String,
}

fn c_string(value: *const c_char, label: &str) -> Result<String, String> {
    if value.is_null() {
        return Err(format!("{label} pointer was null"));
    }

    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(|value| value.to_string())
        .map_err(|error| format!("{label} was not valid UTF-8: {error}"))
}

fn remote_file_name(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or("download.bin")
        .to_string()
}

fn uuid_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".into())
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct WindowsVirtualDragEntry {
    remote_path: String,
    file_name: String,
    transfer_id: String,
}

#[cfg(target_os = "windows")]
#[implement(IDataObject)]
struct WindowsVirtualFileDataObject {
    app: AppHandle,
    session: SessionDefinition,
    entries: Vec<WindowsVirtualDragEntry>,
    staged_paths: Mutex<Vec<Option<PathBuf>>>,
}

#[cfg(target_os = "windows")]
impl WindowsVirtualFileDataObject {
    fn new(app: AppHandle, session: SessionDefinition, entries: Vec<WindowsVirtualDragEntry>) -> Self {
        Self {
            app,
            session,
            staged_paths: Mutex::new(vec![None; entries.len()]),
            entries,
        }
    }

    fn supported_formats() -> [FORMATETC; 2] {
        let (descriptor_format, contents_format) = windows_drag_formats();
        [
            FORMATETC {
                cfFormat: descriptor_format,
                ptd: ptr::null_mut(),
                dwAspect: 1,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            },
            FORMATETC {
                cfFormat: contents_format,
                ptd: ptr::null_mut(),
                dwAspect: 1,
                lindex: -1,
                tymed: TYMED_ISTREAM.0 as u32,
            },
        ]
    }

    fn create_descriptor_medium(&self) -> Result<STGMEDIUM, WindowsError> {
        let descriptors = self
            .entries
            .iter()
            .map(|entry| build_windows_file_descriptor(&entry.file_name))
            .collect::<Vec<_>>();
        let bytes = encode_file_group_descriptor(&descriptors);
        let hglobal = hglobal_from_bytes(&bytes)?;

        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: hglobal },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }

    fn create_file_contents_medium(&self, index: i32) -> Result<STGMEDIUM, WindowsError> {
        let entry_index = usize::try_from(index).map_err(|_| WindowsError::from(DV_E_FORMATETC))?;
        let staged_path = self.stage_file_for_contents(entry_index)?;
        let bytes = fs::read(&staged_path).map_err(|error| {
            WindowsError::new(
                E_FAIL,
                format!("failed to read staged drag file {}: {error}", staged_path.display()),
            )
        })?;
        let stream = unsafe { SHCreateMemStream(Some(&bytes)) }
            .ok_or_else(|| WindowsError::new(E_FAIL, "failed to create Windows drag stream"))?;

        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            pUnkForRelease: ManuallyDrop::new(None),
        })
    }

    fn stage_file_for_contents(&self, entry_index: usize) -> Result<PathBuf, WindowsError> {
        let mut staged_paths = self.staged_paths.lock().map_err(|_| {
            WindowsError::new(E_FAIL, "failed to lock Windows drag cache")
        })?;
        if let Some(path) = staged_paths.get(entry_index).and_then(|path| path.clone()) {
            return Ok(path);
        }

        let entry = self
            .entries
            .get(entry_index)
            .ok_or_else(|| WindowsError::from(DV_E_FORMATETC))?;
        let result = file_ops::prepare_remote_drag_file(
            &self.app,
            &self.session,
            &entry.remote_path,
            entry.transfer_id.clone(),
        )
        .map_err(|error| WindowsError::new(E_FAIL, error))?;
        let path = PathBuf::from(result.saved_to);
        if let Some(slot) = staged_paths.get_mut(entry_index) {
            *slot = Some(path.clone());
        }

        Ok(path)
    }
}

#[cfg(target_os = "windows")]
impl IDataObject_Impl for WindowsVirtualFileDataObject_Impl {
    fn GetData(&self, format_in: *const FORMATETC) -> windows_core::Result<STGMEDIUM> {
        let format_in = unsafe { format_in.as_ref() }.ok_or_else(|| WindowsError::from(E_POINTER))?;
        let (descriptor_format, contents_format) = windows_drag_formats();

        if format_in.cfFormat == descriptor_format {
            if format_in.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
                return Err(WindowsError::from(DV_E_TYMED));
            }
            return self.create_descriptor_medium();
        }

        if format_in.cfFormat == contents_format {
            if format_in.tymed & TYMED_ISTREAM.0 as u32 == 0 {
                return Err(WindowsError::from(DV_E_TYMED));
            }
            return self.create_file_contents_medium(format_in.lindex);
        }

        Err(WindowsError::from(DV_E_FORMATETC))
    }

    fn GetDataHere(
        &self,
        _format: *const FORMATETC,
        _medium: *mut STGMEDIUM,
    ) -> windows_core::Result<()> {
        Err(WindowsError::from(E_NOTIMPL))
    }

    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        let Some(format) = (unsafe { format.as_ref() }) else {
            return E_POINTER;
        };
        let (descriptor_format, contents_format) = windows_drag_formats();

        if format.cfFormat == descriptor_format {
            return if format.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
                DV_E_TYMED
            } else {
                S_OK
            };
        }

        if format.cfFormat == contents_format {
            if format.tymed & TYMED_ISTREAM.0 as u32 == 0 {
                return DV_E_TYMED;
            }

            let index = match usize::try_from(format.lindex) {
                Ok(index) => index,
                Err(_) => return DV_E_FORMATETC,
            };
            return if index < self.entries.len() {
                S_OK
            } else {
                DV_E_FORMATETC
            };
        }

        DV_E_FORMATETC
    }

    fn GetCanonicalFormatEtc(
        &self,
        _format_in: *const FORMATETC,
        format_out: *mut FORMATETC,
    ) -> HRESULT {
        if let Some(format_out) = unsafe { format_out.as_mut() } {
            format_out.ptd = ptr::null_mut();
        }
        DATA_S_SAMEFORMATETC
    }

    fn SetData(
        &self,
        _format: *const FORMATETC,
        _medium: *const STGMEDIUM,
        _release: BOOL,
    ) -> windows_core::Result<()> {
        Err(WindowsError::from(E_NOTIMPL))
    }

    fn EnumFormatEtc(&self, direction: u32) -> windows_core::Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(WindowsError::from(E_NOTIMPL));
        }

        Ok(WindowsFormatEtcEnumerator::new(WindowsVirtualFileDataObject::supported_formats().to_vec()).into())
    }

    fn DAdvise(
        &self,
        _format: *const FORMATETC,
        _advf: u32,
        _sink: windows_core::Ref<'_, IAdviseSink>,
    ) -> windows_core::Result<u32> {
        Err(WindowsError::from(OLE_E_ADVISENOTSUPPORTED))
    }

    fn DUnadvise(&self, _connection: u32) -> windows_core::Result<()> {
        Err(WindowsError::from(OLE_E_ADVISENOTSUPPORTED))
    }

    fn EnumDAdvise(&self) -> windows_core::Result<IEnumSTATDATA> {
        Err(WindowsError::from(OLE_E_ADVISENOTSUPPORTED))
    }
}

#[cfg(target_os = "windows")]
#[implement(IEnumFORMATETC)]
struct WindowsFormatEtcEnumerator {
    formats: Vec<FORMATETC>,
    cursor: Mutex<usize>,
}

#[cfg(target_os = "windows")]
impl WindowsFormatEtcEnumerator {
    fn new(formats: Vec<FORMATETC>) -> Self {
        Self::new_with_cursor(formats, 0)
    }

    fn new_with_cursor(formats: Vec<FORMATETC>, cursor: usize) -> Self {
        Self {
            formats,
            cursor: Mutex::new(cursor),
        }
    }
}

#[cfg(target_os = "windows")]
impl IEnumFORMATETC_Impl for WindowsFormatEtcEnumerator_Impl {
    fn Next(&self, celt: u32, rgelt: *mut FORMATETC, fetched: *mut u32) -> HRESULT {
        let Ok(mut cursor) = self.cursor.lock() else {
            return E_FAIL;
        };
        let requested = celt as usize;
        let available = self.formats.len().saturating_sub(*cursor);
        let count = requested.min(available);

        if count > 0 && !rgelt.is_null() {
            unsafe {
                ptr::copy_nonoverlapping(self.formats.as_ptr().add(*cursor), rgelt, count);
            }
        }
        if !fetched.is_null() {
            unsafe {
                *fetched = count as u32;
            }
        }
        *cursor += count;

        if count == requested {
            S_OK
        } else {
            S_FALSE
        }
    }

    fn Skip(&self, celt: u32) -> windows_core::Result<()> {
        let mut cursor = self.cursor.lock().map_err(|_| {
            WindowsError::new(E_FAIL, "failed to lock Windows drag format enumerator")
        })?;
        *cursor = (*cursor + celt as usize).min(self.formats.len());
        Ok(())
    }

    fn Reset(&self) -> windows_core::Result<()> {
        let mut cursor = self.cursor.lock().map_err(|_| {
            WindowsError::new(E_FAIL, "failed to lock Windows drag format enumerator")
        })?;
        *cursor = 0;
        Ok(())
    }

    fn Clone(&self) -> windows_core::Result<IEnumFORMATETC> {
        let cursor = *self.cursor.lock().map_err(|_| {
            WindowsError::new(E_FAIL, "failed to lock Windows drag format enumerator")
        })?;
        Ok(WindowsFormatEtcEnumerator::new_with_cursor(self.formats.clone(), cursor).into())
    }
}

#[cfg(target_os = "windows")]
fn windows_drag_formats() -> (u16, u16) {
    *WINDOWS_DRAG_FORMATS.get_or_init(|| unsafe {
        (
            RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) as u16,
            RegisterClipboardFormatW(CFSTR_FILECONTENTS) as u16,
        )
    })
}

#[cfg(target_os = "windows")]
fn build_windows_file_descriptor(file_name: &str) -> FILEDESCRIPTORW {
    const FILE_DESCRIPTOR_NAME_CAPACITY: usize = 260;

    let mut descriptor = FILEDESCRIPTORW {
        dwFlags: (FD_ATTRIBUTES.0 | FD_PROGRESSUI.0 | FD_UNICODE.0) as u32,
        dwFileAttributes: FILE_ATTRIBUTE_NORMAL.0,
        ..Default::default()
    };
    let wide_name = wide_null(file_name);
    let name_len = wide_name
        .len()
        .saturating_sub(1)
        .min(FILE_DESCRIPTOR_NAME_CAPACITY - 1);
    unsafe {
        ptr::copy_nonoverlapping(
            wide_name.as_ptr(),
            ptr::addr_of_mut!(descriptor.cFileName) as *mut u16,
            name_len,
        );
    }
    descriptor
}

#[cfg(target_os = "windows")]
fn encode_file_group_descriptor(descriptors: &[FILEDESCRIPTORW]) -> Vec<u8> {
    let descriptor_size = size_of::<FILEDESCRIPTORW>();
    let mut bytes = vec![0u8; size_of::<u32>() + descriptors.len() * descriptor_size];
    bytes[..size_of::<u32>()].copy_from_slice(&(descriptors.len() as u32).to_le_bytes());

    for (index, descriptor) in descriptors.iter().enumerate() {
        let offset = size_of::<u32>() + index * descriptor_size;
        unsafe {
            ptr::copy_nonoverlapping(
                descriptor as *const FILEDESCRIPTORW as *const u8,
                bytes.as_mut_ptr().add(offset),
                descriptor_size,
            );
        }
    }

    bytes
}

#[cfg(target_os = "windows")]
fn hglobal_from_bytes(bytes: &[u8]) -> windows_core::Result<windows::Win32::Foundation::HGLOBAL> {
    let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len()) }?;
    let buffer = unsafe { GlobalLock(hglobal) } as *mut u8;
    if buffer.is_null() {
        return Err(WindowsError::new(E_FAIL, "failed to lock Windows drag buffer"));
    }

    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), buffer, bytes.len());
    }
    let _ = unsafe { GlobalUnlock(hglobal) };

    Ok(hglobal)
}

#[cfg(target_os = "windows")]
fn wide_null(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

#[cfg(target_os = "windows")]
#[implement(IDropSource)]
struct WindowsDropSource;

#[cfg(target_os = "windows")]
impl IDropSource_Impl for WindowsDropSource_Impl {
    fn QueryContinueDrag(
        &self,
        escape_pressed: BOOL,
        key_state: MODIFIERKEYS_FLAGS,
    ) -> HRESULT {
        if escape_pressed.as_bool() {
            DRAGDROP_S_CANCEL
        } else if !key_state.contains(MK_LBUTTON) {
            DRAGDROP_S_DROP
        } else {
            HRESULT(0)
        }
    }

    fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}
