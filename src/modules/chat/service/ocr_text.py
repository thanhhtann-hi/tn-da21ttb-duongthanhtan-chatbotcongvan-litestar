# file: modules/chat/service/ocr_text.py
# updated: 2025-08-31 (v2.2.0)
# notes:
#   - Keep OCR returning full pages_text & spans; trimming policy handled by caller (chat_api)
#   - Default PAGE_MARK_ENABLE=0 to match .env (no per-page headers inside pages_text)
#   - Pillow safety: allow large images (MAX_IMAGE_PIXELS=None)
#   - Cache round-trip hardening

from __future__ import annotations

import os, re, sys, math, json, time, asyncio, hashlib, logging, unicodedata
from dataclasses import dataclass, asdict
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    # ✅ type-hint đúng, không dùng module như type để tránh Pylance cảnh báo
    from PIL.Image import Image as PILImage
    from numpy.typing import NDArray as _NDArray
    CVMat = _NDArray[Any]
else:
    PILImage = Any
    CVMat = Any

__all__ = [
    "OCRResult", "PageInfo",
    "extract_text", "extract_text_async",
    "page_for_pos", "pages_for_range", "guess_pages_from_snippet",
    "cer", "wer",
]

logger = logging.getLogger("docaix.ocr")
if not logger.handlers:
    logging.basicConfig(level=(logging.DEBUG if os.getenv("OCR_DEBUG", "0").strip() == "1" else logging.INFO))

# ── Optional imports ──────────────────────────────────────────────────────────
try:
    import fitz  # PyMuPDF
except Exception:
    fitz = None  # type: ignore

try:
    from PIL import Image, ImageOps, ImageFilter
    try:
        # an toàn cho ảnh siêu lớn (scan khổ cao)
        Image.MAX_IMAGE_PIXELS = None  # type: ignore[attr-defined]
    except Exception:
        pass
except Exception:
    Image = ImageOps = ImageFilter = None  # type: ignore

try:
    import cv2  # type: ignore
except Exception:
    cv2 = None  # type: ignore

try:
    import pytesseract
    if os.name == "nt":
        _default_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
        if os.path.isfile(_default_cmd):
            pytesseract.pytesseract.tesseract_cmd = _default_cmd  # type: ignore[attr-defined]
except Exception:
    pytesseract = None  # type: ignore

try:
    import easyocr  # type: ignore
except Exception:
    easyocr = None  # type: ignore

try:
    import torch  # type: ignore
except Exception:
    torch = None  # type: ignore

# ✅ GPU speed-ups: TF32 + cuDNN benchmark
try:
    if torch and torch.cuda.is_available():  # type: ignore[attr-defined]
        torch.backends.cuda.matmul.allow_tf32 = True  # type: ignore[attr-defined]
        torch.backends.cudnn.allow_tf32 = True        # type: ignore[attr-defined]
        if hasattr(torch, "set_float32_matmul_precision"):
            torch.set_float32_matmul_precision("high")  # type: ignore[attr-defined]
        torch.backends.cudnn.benchmark = True          # type: ignore[attr-defined]
except Exception:
    pass

# ── ENV ───────────────────────────────────────────────────────────────────────
TESSDATA_PREFIX = os.getenv("TESSDATA_PREFIX", os.getenv("OCR_TESSDATA_PREFIX", "")).strip()
if TESSDATA_PREFIX and "TESSDATA_PREFIX" not in os.environ:
    os.environ["TESSDATA_PREFIX"] = TESSDATA_PREFIX

OCR_IMG_LANG = (os.getenv("OCR_IMG_LANG", "vie").strip() or "vie")
OCR_PDF_LANG = (os.getenv("OCR_PDF_LANG", "vie+eng").strip() or "vie+eng")
OCR_VI_OEM = int(os.getenv("OCR_VI_OEM", "1"))
OCR_VI_PSM = (os.getenv("OCR_VI_PSM", "6").strip() or "6")
# chấp nhận "6" hoặc "6,4,3"
_ocr_psm_env = os.getenv("OCR_PSM_LIST", "6")
OCR_PSM_LIST = [s.strip() for s in re.split(r"[,\s]+", _ocr_psm_env) if s.strip()]
OCR_MIN_DPI = max(200, int(os.getenv("OCR_MIN_DPI", "260")))
OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "200"))  # Giới hạn OCR nội bộ
OCR_FORCE_OCR_ALL = os.getenv("OCR_FORCE_OCR_ALL", "0").strip() == "1"
OCR_TEXT_THRESHOLD = int(os.getenv("OCR_TEXT_THRESHOLD", "40"))
OCR_PIXEL_LIMIT = int(os.getenv("OCR_PIXEL_LIMIT", str(17_000_000)))
OCR_CACHE_DIR = os.path.abspath(os.getenv("OCR_CACHE_DIR", "data/ocr_cache"))
OCR_DEBUG = os.getenv("OCR_DEBUG", "0").strip() == "1"

# Backend policy
OCR_ENGINE = (os.getenv("OCR_ENGINE", "auto").strip().lower() or "auto")
EASYOCR_LANGS = [s.strip() for s in (os.getenv("EASYOCR_LANGS", "vi,en").split(",")) if s.strip()]
EASYOCR_GPU = os.getenv("EASYOCR_GPU", "1").strip() != "0"
OCR_AUTO_GPU_FIRST = os.getenv("OCR_AUTO_GPU_FIRST", "1").strip() != "0"
EASYOCR_PARAGRAPH = os.getenv("EASYOCR_PARAGRAPH", "1").strip() != "0"           # ✅ paragraph mode
MIN_CHARS_FALLBACK = int(os.getenv("OCR_MIN_CHARS_FALLBACK", "40"))              # ✅ retry threshold

# Upscale policy
OCR_UPSCALE_ENABLE = os.getenv("OCR_UPSCALE_ENABLE", "1").strip() != "0"
OCR_UPSCALE_MIN_SIDE = int(os.getenv("OCR_UPSCALE_MIN_SIDE", "1400"))
OCR_UPSCALE_MAX_SIDE = int(os.getenv("OCR_UPSCALE_MAX_SIDE", "2800"))
OCR_UPSCALE_MAX_PIXELS = int(os.getenv("OCR_UPSCALE_MAX_PIXELS", "25000000"))
OCR_UPSCALE_FACTOR_MAX = float(os.getenv("OCR_UPSCALE_FACTOR_MAX", "2.0"))
OCR_UPSCALE_ALGO = os.getenv("OCR_UPSCALE_ALGO", "pil-lanczos").strip().lower()
OCR_UPSCALE_TARGET_DPI = int(os.getenv("OCR_UPSCALE_TARGET_DPI", "360"))

# Post-process
POST_ENABLE = os.getenv("OCR_POST_ENABLE", "1").strip() != "0"
POST_CLEAN_ENABLE = os.getenv("OCR_POST_CLEAN_ENABLE", "1").strip() != "0"
POST_MARK_NOINHAN = os.getenv("OCR_POST_MARK_NOINHAN", "1").strip() != "0"
POST_NOINHAN_COLLAPSE = os.getenv("OCR_POST_NOINHAN_COLLAPSE", "1").strip() != "0"
POST_KEEP_PUNCT = os.getenv("OCR_POST_KEEP_PUNCT", '.,:"“”‟”’"：').strip()
NOINHAN_MAX_DIST = int(os.getenv("OCR_POST_NOINHAN_MAX_DIST", "3"))
NOINHAN_MAX_LINES = int(os.getenv("OCR_POST_NOINHAN_MAX_LINES", "18"))

# Page markers & join-lines (mặc định tắt, khớp .env của bạn)
PAGE_MARK_ENABLE = os.getenv("OCR_PAGE_MARK_ENABLE", "0").strip() != "0"
PAGE_MARK_FMT = os.getenv("OCR_PAGE_MARK_FMT", '=== [PAGE {i}/{total}] ===').strip()
JOIN_LOWERCASE_CONT = os.getenv("OCR_JOIN_LOWERCASE_CONTINUATION", "1").strip() != "0"

# Noise / repeat / corrections (tùy chọn)
DROP_NOISE_PAGES = os.getenv("OCR_DROP_NOISE_PAGES", "0").strip() == "1"
NOISE_ASCII_RATIO = float(os.getenv("OCR_NOISE_ASCII_RATIO", "0.985"))
NOISE_DIACRITIC = float(os.getenv("OCR_NOISE_DIACRITIC", "0.01"))
NOISE_MINLEN = int(os.getenv("OCR_NOISE_MINLEN", "120"))
DROP_REPEAT_LINES = os.getenv("OCR_DROP_REPEAT_LINES", "0").strip() == "1"
REPEAT_MIN_FREQ = float(os.getenv("OCR_REPEAT_MIN_FREQ", "0.5"))
CORR_JSON = os.getenv("OCR_CORR_JSON", "").strip()

# ── Models ────────────────────────────────────────────────────────────────────
@dataclass
class PageInfo:
    index: int
    source: str               # 'pdf-text' | 'ocr' | 'image-ocr' | 'skipped' | 'error'
    chars: int
    secs: float
    dpi: int | None = None
    note: str | None = None
    avg_conf: float | None = None

@dataclass
class OCRResult:
    ok: bool
    text: str
    text_path: str | None
    cache_hit: bool
    total_pages: int
    ocr_pages: int
    pdf_text_pages: int
    pages: list[PageInfo]
    engine: str
    # ✅ bổ sung cho BE/FE:
    is_pdf: bool = False
    page_spans: list[dict[str, int]] | None = None
    pages_text: list[str] | None = None  # text theo trang (đÃ hậu xử lý, KHÔNG kèm header)
    meta_path: str | None = None
    avg_confidence: float | None = None
    diacritic_ratio: float | None = None
    ascii_word_ratio: float | None = None
    error: str | None = None
    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)

# ── Helpers ───────────────────────────────────────────────────────────────────
def _ensure_dir(p: str) -> None:
    try:
        os.makedirs(p, exist_ok=True)
    except Exception:
        pass

def _read_text(p: str) -> str:
    with open(p, "r", encoding="utf-8") as f:
        return f.read()

def _write_text(p: str, t: str) -> None:
    _ensure_dir(os.path.dirname(p))
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(t)

def _sha1_file(path: str, buf: int = 1024 * 1024) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            b = f.read(buf)
            if not b:
                break
            h.update(b)
    return h.hexdigest()

def _is_pdf(p: str) -> bool:
    return os.path.splitext(p.lower())[1] == ".pdf"

def _is_image(p: str) -> bool:
    return os.path.splitext(p.lower())[1] in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")

def _safe_int(x: object, default: int = 0) -> int:
    try:
        return int(x)  # type: ignore[arg-type]
    except Exception:
        return default

def _safe_int_or_none(x: object) -> int | None:
    try:
        return int(x)  # type: ignore[arg-type]
    except Exception:
        return None

# ── VI cleanup & metrics ──────────────────────────────────────────────────────
_VI_ACCENTED = set("ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ")
_VI_BASE = set("aăâbcdđeêghiklmnoôơpqrstuưvxyý")

def _nfc(t: str) -> str:
    return unicodedata.normalize("NFC", t)

def _normalize_vi_text(text: str) -> str:
    t = _nfc(text)
    t = re.sub(r"(\w)-\n(\w)", r"\1\2", t)
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = "\n".join(s.rstrip() for s in t.splitlines())
    return t.strip()

def _strip_diacritics(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")

def _vi_quality_metrics(text: str) -> tuple[float, float]:
    if not text:
        return 0.0, 1.0
    tokens = re.findall(r"\w+", text, flags=re.UNICODE)
    ascii_tokens = sum(1 for w in tokens if all(ord(c) < 128 for c in w))
    ascii_word_ratio = ascii_tokens / max(1, len(tokens))
    vi_letters = [c for c in text.lower() if c.isalpha() and c in _VI_BASE.union(_VI_ACCENTED)]
    if not vi_letters:
        return 0.0, ascii_word_ratio
    accented = sum(1 for c in vi_letters if c in _VI_ACCENTED)
    diacritic_ratio = accented / max(1, len(vi_letters))
    return diacritic_ratio, ascii_word_ratio

def _vi_ocr_looks_bad(txt: str, lang_combo: str) -> bool:
    if not txt or "vie" not in (lang_combo or ""):
        return False
    d, a = _vi_quality_metrics(txt)
    return (len(txt) >= 80) and (a > 0.95) and (d < 0.02)

# ── OpenCV/PIL preprocessing & Upscale ────────────────────────────────────────
def _pil_to_cv(img: PILImage) -> CVMat:
    import numpy as _np
    if cv2 is None:
        return _np.array(img)  # type: ignore[return-value]
    return cv2.cvtColor(_np.array(img), cv2.COLOR_RGB2BGR)  # type: ignore[attr-defined]

def _cv_to_pil(arr: CVMat) -> PILImage:
    if cv2 is None or Image is None:
        from PIL import Image as _Image  # type: ignore
        return _Image.fromarray(arr)  # type: ignore[arg-type]
    return Image.fromarray(cv2.cvtColor(arr, cv2.COLOR_BGR2RGB))  # type: ignore[attr-defined]

def _deskew_cv(gray: CVMat) -> tuple[CVMat, float]:
    assert cv2 is not None
    edges = cv2.Canny(gray, 50, 150)  # type: ignore[attr-defined]
    coords = cv2.findNonZero(edges)  # type: ignore[attr-defined]
    if coords is None:
        return gray, 0.0
    rect = cv2.minAreaRect(coords)  # type: ignore[attr-defined]
    angle = rect[-1]
    if angle < -45:
        angle = 90 + angle
    M = cv2.getRotationMatrix2D((gray.shape[1] / 2, gray.shape[0] / 2), angle, 1.0)  # type: ignore[attr-defined]
    rot = cv2.warpAffine(gray, M, (gray.shape[1], gray.shape[0]), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)  # type: ignore[attr-defined]
    return rot, float(angle)

def _preprocess_vi(img: PILImage) -> tuple[PILImage, dict]:
    dbg = {"deskew_deg": 0.0, "method": "pil"}
    if cv2 is not None:
        dbg["method"] = "cv2"
        cv = _pil_to_cv(img)
        gray = cv2.cvtColor(cv, cv2.COLOR_BGR2GRAY)  # type: ignore[attr-defined]
        gray, deg = _deskew_cv(gray)
        dbg["deskew_deg"] = float(deg)
        _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)  # type: ignore[attr-defined]
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 1))  # type: ignore[attr-defined]
        bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel, iterations=1)  # type: ignore[attr-defined]
        blur = cv2.GaussianBlur(bw, (0, 0), 1.0)  # type: ignore[attr-defined]
        sharp = cv2.addWeighted(bw, 1.4, blur, -0.4, 0)  # type: ignore[attr-defined]
        out = _cv_to_pil(cv2.cvtColor(sharp, cv2.COLOR_GRAY2BGR))  # type: ignore[attr-defined]
    else:
        out = img.convert("L")
        try:
            if ImageOps:
                out = ImageOps.autocontrast(out, cutoff=1)
            if ImageFilter:
                out = out.filter(ImageFilter.SHARPEN)
        except Exception:
            pass
    return out, dbg

def _maybe_upscale(img: PILImage) -> tuple[PILImage, dict]:
    dbg = {"factor": 1.0, "before": img.size, "after": img.size, "reason": ""}
    if not OCR_UPSCALE_ENABLE or Image is None:
        return img, dbg
    w, h = img.size
    min_side = min(w, h)
    if min_side >= OCR_UPSCALE_MIN_SIDE:
        dbg["reason"] = "big-enough"
        return img, dbg
    factor = min(float(OCR_UPSCALE_MIN_SIDE) / max(1.0, float(min_side)), OCR_UPSCALE_FACTOR_MAX)
    if factor <= 1.01:
        dbg["reason"] = "factor<=1"
        return img, dbg
    nw, nh = int(round(w * factor)), int(round(h * factor))
    if max(nw, nh) > OCR_UPSCALE_MAX_SIDE:
        s = OCR_UPSCALE_MAX_SIDE / float(max(nw, nh))
        nw, nh = int(round(nw * s)), int(round(nh * s))
        factor *= s
    if (nw * nh) > OCR_UPSCALE_MAX_PIXELS:
        s = math.sqrt(OCR_UPSCALE_MAX_PIXELS / float(nw * nh))
        nw, nh = int(round(nw * s)), int(round(nh * s))
        factor *= s
    if factor <= 1.01:
        dbg["reason"] = "pixel/side-limited"
        return img, dbg
    try:
        if OCR_UPSCALE_ALGO.startswith("cv2") and cv2 is not None:
            inter = cv2.INTER_LANCZOS4 if OCR_UPSCALE_ALGO.endswith("lanczos4") else cv2.INTER_CUBIC
            out = _cv_to_pil(cv2.resize(_pil_to_cv(img), (nw, nh), interpolation=inter))  # type: ignore[attr-defined]
        else:
            res = Image.LANCZOS if OCR_UPSCALE_ALGO.startswith("pil") else Image.BICUBIC
            out = img.resize((nw, nh), res)
    except Exception:
        out = img.resize((nw, nh), Image.LANCZOS if Image else None)  # type: ignore[arg-type]
    dbg.update({"factor": float(factor), "after": (nw, nh), "reason": "small"})
    return out, dbg

# ── Tesseract ─────────────────────────────────────────────────────────────────
def _tess_cfg(psm: str | None = None) -> str:
    psm_sel = (psm or OCR_VI_PSM or "6").strip()
    cfg = f"--oem {OCR_VI_OEM} --psm {psm_sel} -c preserve_interword_spaces=1 -c tessedit_do_invert=1 -c user_defined_dpi=400"
    uw = os.getenv("OCR_VI_USER_WORDS", "").strip()
    up = os.getenv("OCR_VI_USER_PATTERNS", "").strip()
    if uw and os.path.isfile(uw):
        cfg += f' --user-words "{uw}"'
    if up and os.path.isfile(up):
        cfg += f' --user-patterns "{up}"'
    return cfg

def _osd_rotate(img: PILImage) -> tuple[PILImage, int | None]:
    if pytesseract is None:
        return img, None
    try:
        osd = pytesseract.image_to_osd(img)  # type: ignore[attr-defined]
        m = re.search(r"Rotate: (\d+)", osd or "")
        if m:
            deg = int(m.group(1)) % 360
            if deg and Image:
                return img.rotate(360 - deg, expand=True), deg
            return img, 0
    except Exception:
        pass
    return img, None

def _ocr_pil_tesseract(img: PILImage, *, lang: str) -> tuple[str, float | None]:
    if pytesseract is None:
        raise RuntimeError("pytesseract chưa sẵn sàng.")
    img_rot, _ = _osd_rotate(img)
    pre, _ = _preprocess_vi(img_rot)
    last_txt, last_conf = "", None
    for psm in (OCR_PSM_LIST or [OCR_VI_PSM, "6"]):
        cfg = _tess_cfg(psm)
        try:
            txt = pytesseract.image_to_string(pre, lang=lang, config=cfg) or ""  # type: ignore[attr-defined]
            conf_val = None
            try:
                data = pytesseract.image_to_data(pre, lang=lang, config=cfg, output_type=pytesseract.Output.DICT)  # type: ignore[attr-defined]
                confs = [float(c) for c in (data.get("conf") or []) if c not in ("-1", -1)]
                if confs:
                    conf_val = sum(confs) / len(confs)
            except Exception:
                pass
            if (conf_val or -1) > (last_conf or -1) or len(txt) > len(last_txt):
                last_txt, last_conf = txt, conf_val
        except Exception as e:
            logger.debug("PSM %s failed: %s", psm, e)
            continue
    return last_txt, last_conf

# ── EasyOCR ───────────────────────────────────────────────────────────────────
_EASY_READER = None
_EASY_READER_KEY: tuple[tuple[str, ...], bool] | None = None

def _gpu_diag() -> dict:
    info = {
        "torch_imported": torch is not None,
        "torch_version": getattr(torch, "__version__", None) if torch else None,
        "torch_cuda_available": bool(torch.cuda.is_available()) if torch else False,  # type: ignore[attr-defined]
        "torch_cuda_version": getattr(torch.version, "cuda", None) if torch else None,  # type: ignore[attr-defined]
        "easyocr_imported": easyocr is not None,
        "EASYOCR_GPU": EASYOCR_GPU,
        "OCR_ENGINE": OCR_ENGINE,
        "AUTO_GPU_FIRST": OCR_AUTO_GPU_FIRST,
    }
    if OCR_DEBUG:
        logger.debug("GPU DIAG: %s", info)
    return info

def _get_easyocr_reader(langs: list[str], gpu: bool):
    global _EASY_READER, _EASY_READER_KEY
    if easyocr is None:
        raise RuntimeError("easyocr chưa sẵn sàng. pip install easyocr")
    key = (tuple(langs), bool(gpu))
    if _EASY_READER is not None and _EASY_READER_KEY == key:
        return _EASY_READER
    _EASY_READER = easyocr.Reader(langs, gpu=gpu, verbose=False)
    _EASY_READER_KEY = key
    return _EASY_READER

def _langs_for_easyocr(lang_combo: str | None) -> list[str]:
    if not lang_combo:
        return EASYOCR_LANGS
    tokens = [s for s in re.split(r"[+,\s]+", lang_combo) if s]
    m = {"vie": "vi", "eng": "en"}
    mapped = [m.get(t.lower(), t.lower()) for t in tokens]
    mapped = [c for c in mapped if c in {"vi", "en"}]
    return mapped or EASYOCR_LANGS

def _easyocr_input_from_pil(img: PILImage):
    import numpy as _np
    arr = _np.asarray(img)
    # EasyOCR (qua OpenCV) dùng BGR; nếu có cv2, convert RGB->BGR
    if cv2 is not None and arr.ndim == 3 and arr.shape[2] == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)  # type: ignore[attr-defined]
    return arr

def _easyocr_read_pil(img: PILImage, langs: list[str], paragraph: bool | None = None) -> tuple[str, float | None]:
    reader = _get_easyocr_reader(langs, EASYOCR_GPU)
    np_img = _easyocr_input_from_pil(img)

    par = EASYOCR_PARAGRAPH if paragraph is None else bool(paragraph)

    def _run(paragraph_flag: bool) -> tuple[str, float | None]:
        result = reader.readtext(np_img, detail=1, paragraph=paragraph_flag)
        texts, confs = [], []
        for *_, text, conf in result:
            if isinstance(text, str) and text.strip():
                texts.append(text)
            try:
                if conf is not None:
                    confs.append(float(conf))
            except Exception:
                pass
        txt = "\n".join(texts).strip()
        avg = (sum(confs) / len(confs)) if confs else None
        return txt, avg

    txt, avg = _run(par)

    # ✅ fallback: nếu paragraph ra quá ít ký tự → thử word-mode
    if len(txt) < MIN_CHARS_FALLBACK and par:
        txt2, avg2 = _run(False)
        if len(txt2) > len(txt):
            txt, avg = txt2, avg2

    return txt, avg

def _ocr_with_backend_pil(img: PILImage, *, lang_combo: str) -> tuple[str, float | None, str]:
    img, _ = _maybe_upscale(img)

    # forced backends
    if OCR_ENGINE == "easyocr":
        txt, conf = _easyocr_read_pil(img, _langs_for_easyocr(lang_combo)); used = "easyocr"
        if len((txt or "").strip()) < MIN_CHARS_FALLBACK and pytesseract is not None:
            t2, c2 = _ocr_pil_tesseract(img, lang=lang_combo)
            if len(t2) > len(txt):
                txt, conf, used = t2, c2, "tesseract"
        if OCR_DEBUG:
            logger.debug("Backend forced: %s", used)
        return txt, conf, used

    if OCR_ENGINE == "tesseract":
        txt, conf = _ocr_pil_tesseract(img, lang=lang_combo); used = "tesseract"
        if len((txt or "").strip()) < MIN_CHARS_FALLBACK and easyocr is not None:
            t2, c2 = _easyocr_read_pil(img, _langs_for_easyocr(lang_combo), paragraph=False)
            if len(t2) > len(txt):
                txt, conf, used = t2, c2, "easyocr"
        if OCR_DEBUG:
            logger.debug("Backend forced: %s", used)
        return txt, conf, used

    # auto
    chosen: tuple[str, float | None, str] | None = None
    if OCR_AUTO_GPU_FIRST:
        diag = _gpu_diag()
        if diag["easyocr_imported"] and diag["torch_imported"] and diag["torch_cuda_available"] and EASYOCR_GPU:
            try:
                t, c = _easyocr_read_pil(img, _langs_for_easyocr(lang_combo))
                chosen = (t, c, "easyocr")
            except Exception as e:
                if OCR_DEBUG:
                    logger.debug("EasyOCR GPU failed → fallback: %s", e)
        if chosen is None and pytesseract is not None:
            try:
                t, c = _ocr_pil_tesseract(img, lang=lang_combo)
                chosen = (t, c, "tesseract")
            except Exception as e:
                if OCR_DEBUG:
                    logger.debug("Tesseract failed → try EasyOCR CPU: %s", e)
        if chosen is None and easyocr is not None:
            t, c = _easyocr_read_pil(img, _langs_for_easyocr(lang_combo))
            chosen = (t, c, "easyocr")
    else:
        if pytesseract is not None:
            try:
                t, c = _ocr_pil_tesseract(img, lang=lang_combo)
                chosen = (t, c, "tesseract")
            except Exception:
                pass
        if chosen is None and easyocr is not None:
            t, c = _easyocr_read_pil(img, _langs_for_easyocr(lang_combo))
            chosen = (t, c, "easyocr")

    if chosen is None:
        raise RuntimeError("Không có backend OCR khả dụng.")

    txt, conf, used = chosen

    # ✅ min-chars fallback trong chế độ auto
    if len((txt or "").strip()) < MIN_CHARS_FALLBACK:
        if used == "easyocr" and pytesseract is not None:
            t2, c2 = _ocr_pil_tesseract(img, lang=lang_combo)
            if len(t2) > len(txt):
                txt, conf, used = t2, c2, "tesseract"
        elif used == "tesseract" and easyocr is not None:
            t2, c2 = _easyocr_read_pil(img, _langs_for_easyocr(lang_combo), paragraph=False)
            if len(t2) > len(txt):
                txt, conf, used = t2, c2, "easyocr"

    if OCR_DEBUG:
        logger.debug("Auto chose: %s", used)
    return txt, conf, used

# ── Post-process & utilities ──────────────────────────────────────────────────
_KEEP_PUNCT_SET = set(POST_KEEP_PUNCT)
_PAGE_LINE_RE = re.compile(r'(?i)^\s*page\s+\d+\s*(?:/|\s)\s*\d+\s*$')

def _strip_scanner_banners(s: str) -> str:
    lines = []
    for ln in s.splitlines():
        t = ln.strip()
        if _PAGE_LINE_RE.match(t):
            continue
        lines.append(ln)
    return "\n".join(lines)

def _apply_corrections(text: str) -> str:
    path = CORR_JSON
    if not path or not os.path.isfile(path):
        return text
    try:
        with open(path, "r", encoding="utf-8") as f:
            mapping = json.load(f)
        for pat, repl in mapping.items():
            try:
                if isinstance(pat, str) and pat.startswith("re:"):
                    text = re.sub(pat[3:], repl, text)
                else:
                    text = text.replace(pat, repl)
            except Exception:
                continue
    except Exception:
        pass
    return text

def _clean_text_chars(text: str) -> str:
    out = []
    for ch in text:
        if ch.isalnum() or ch.isspace() or ch in _KEEP_PUNCT_SET or ch == ",":
            out.append(ch)
        else:
            out.append(" ")
    s = "".join(out)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]+\n", "\n", s)
    s = re.sub(r"[ \t]+([.,:：\"“”])", r"\1", s)
    s = re.sub(r"([.:：\"])([^\s])", r"\1 \2", s)
    return s.strip()

def _lev(a: str, b: str) -> int:
    n, m = len(a), len(b)
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        ca = a[i - 1]
        for j in range(1, m + 1):
            cb = b[j - 1]
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (0 if ca == cb else 1))
            prev = cur
    return dp[m]

def _looks_like_noinhan_line(line: str) -> bool:
    m = re.search(r":|：", line)
    if not m:
        return False
    head = line[: m.start()].strip(" .•*-—–•\t")
    if not head:
        return False
    s = _strip_diacritics(head).lower()
    s = re.sub(r"[^a-z]", "", s).replace("j", "n").replace("l", "i")
    if s.startswith("noi") and "nhan" in s[:12]:
        return True
    return _lev(s, "noinhan") <= NOINHAN_MAX_DIST

def _normalize_noinhan_header(prefix_spaces: str = "") -> str:
    return f"{prefix_spaces}. Nơi nhận:"

def _clean_item_text(s: str) -> str:
    s = s.strip()
    s = re.sub(r'^\s*(?:[-*•–—]+|\d+[\).-])\s*', "", s)
    return s.strip(" ,;")

def _collapse_noinhan_blocks(text: str) -> str:
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        l = raw.lstrip()
        if not l:
            i += 1
            continue
        if _looks_like_noinhan_line(l):
            indent = raw[: len(raw) - len(l)]
            header = _normalize_noinhan_header(indent)
            items = []
            j = i + 1
            used = 0
            while j < len(lines) and used < NOINHAN_MAX_LINES:
                cur = lines[j].strip()
                if cur == "":
                    if j + 1 < len(lines) and lines[j + 1].strip() == "":
                        break
                    j += 1; used += 1; continue
                if re.fullmatch(r"[.,:“”\" ]+", cur):
                    j += 1; used += 1; continue
                piece = _clean_item_text(cur)
                if piece:
                    items.append(piece)
                    if re.search(r"\.\s*$", cur):
                        j += 1; used += 1; break
                j += 1; used += 1
            joined = ", ".join(items)
            joined = re.sub(r"\s{2,}", " ", joined).strip()
            if joined and not joined.endswith("."):
                joined += "."
            lines[i] = f"{header} {joined}".rstrip()
            del lines[i + 1 : j]
            i += 1
            continue
        i += 1
    return "\n".join(lines)

def _mark_noinhan_only(text: str) -> str:
    out = []
    for raw in text.splitlines():
        l = raw.lstrip()
        if _looks_like_noinhan_line(l):
            indent = raw[: len(raw) - len(l)]
            out.append(_normalize_noinhan_header(indent) + l[l.find(":") :])
        else:
            out.append(raw)
    return "\n".join(out)

_LEADING_JUNK = re.compile(r'^[\s\(\[\{\'"“‘«]+')
_LEADING_OPENERS = '(\'"“‘«[{'  # ký tự mở được phép bỏ qua

def _first_alpha_case(s: str) -> tuple[int | None, bool | None]:
    for idx, ch in enumerate(s):
        if ch.isalpha():
            return idx, ch.islower()
        if ch.isspace() or ch in _LEADING_OPENERS:
            continue
        return None, None
    return None, None

def _join_lowercase_continuations(text: str) -> str:
    if not JOIN_LOWERCASE_CONT:
        return text
    lines = text.splitlines()
    out = []
    buf = ""
    for line in lines:
        stripped = _LEADING_JUNK.sub("", line)
        if buf == "":
            buf = stripped.lstrip()
            continue
        idx, is_lower = _first_alpha_case(stripped)
        if idx is not None and is_lower:
            if not buf.endswith(" "):
                buf += " "
            buf += stripped
        else:
            out.append(buf.rstrip())
            buf = stripped.lstrip()
        if stripped == "":
            if buf != "":
                out.append(buf.rstrip())
                buf = ""
            out.append("")
    if buf != "":
        out.append(buf.rstrip())
    norm = []
    for s in out:
        if s == "" and len(norm) >= 2 and norm[-1] == "" and norm[-2] == "":
            continue
        norm.append(s)
    return "\n".join(norm).strip()

from collections import Counter

def _drop_repeated_lines_by_freq(pages_text: list[str], min_freq: float = 0.5) -> list[str]:
    freq = Counter()
    per_page = []
    for ptxt in pages_text:
        ls = [ln.strip() for ln in ptxt.splitlines() if len(ln.strip()) >= 8]
        per_page.append(set(ls))
        freq.update(set(ls))
    n_pages = max(1, len(pages_text))
    ban = {line for line, c in freq.items() if (c / n_pages) >= min_freq}
    out = []
    for raw in pages_text:
        keep = []
        for ln in raw.splitlines():
            if ln.strip() in ban:
                continue
            keep.append(ln)
        out.append("\n".join(keep))
    return out

def _apply_post_filters(parts: list[str]) -> list[str]:
    if DROP_REPEAT_LINES and parts:
        split = []
        for body in parts:
            if PAGE_MARK_ENABLE and body.startswith("="):
                p = body.find("\n")
                head, tail = (body[:p], body[p + 1 :]) if p != -1 else (body, "")
                split.append((head, tail))
            else:
                split.append(("", body))
        bodies = [b for _, b in split]
        bodies = _drop_repeated_lines_by_freq(bodies, min_freq=REPEAT_MIN_FREQ)
        parts = [(h + ("\n" + b if b else "")) for (h, _), b in zip(split, bodies)]
    return parts

def _post_process(text: str) -> str:
    out = _strip_scanner_banners(text)
    if POST_CLEAN_ENABLE:
        out = _clean_text_chars(out)
    if POST_NOINHAN_COLLAPSE:
        out = _collapse_noinhan_blocks(out)
    elif POST_MARK_NOINHAN:
        out = _mark_noinhan_only(out)
    out = _normalize_vi_text(out)
    out = _join_lowercase_continuations(out)
    out = _apply_corrections(out)
    return out

# ── Page header helper ────────────────────────────────────────────────────────
def _wrap_page_header(i: int, total: int, body: str) -> str:
    if not PAGE_MARK_ENABLE:
        return (body or "").strip()
    try:
        header = PAGE_MARK_FMT.format(i=i, total=total)
    except Exception:
        header = f"=== [PAGE {i}/{total}] ==="
    body = (body or "").strip()
    return header + ("\n" + body if body else "")

# ── Core: PDF & Image ─────────────────────────────────────────────────────────
def _eff_zoom_with_limit(zoom: float, w: float, h: float, limit: int) -> float:
    est = int(w * zoom) * int(h * zoom)
    if est <= limit:
        return zoom
    return zoom * math.sqrt(limit / max(1, est))

def _pdf_extract_text_or_ocr(
    file_path: str,
    *,
    lang: str,
    dpi: int,
    max_pages: int,
    ocr_all: bool,
    text_threshold: int,
    pixel_limit: int,
) -> tuple[str, list[PageInfo], int, int, str, list[dict[str, int]], list[str]]:
    """
    Trả về:
      - full (chưa hậu xử lý),
      - pages_info,
      - total, ocr_pages, engine_mix,
      - page_spans (chưa trim),
      - parts_noheader: list[str] (text theo trang, KHÔNG header, CHƯA hậu xử lý)
    """
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) chưa được cài, không thể xử lý PDF.")
    doc = fitz.open(file_path)
    total = min(len(doc), max_pages)
    pages: list[PageInfo] = []
    parts_wrapped: list[str] = []
    parts_noheader: list[str] = []
    ocr_pages = 0
    engines = []
    base_zoom = max(dpi / 72.0, (OCR_UPSCALE_TARGET_DPI / 72.0) if OCR_UPSCALE_ENABLE else 1.0)
    base_zoom = max(1.0, base_zoom)

    def _need_ocr(pg: Any) -> bool:
        if ocr_all:
            return True
        try:
            txt = pg.get_text("text") or ""
            return len(txt.strip()) < text_threshold
        except Exception:
            return True

    for i in range(total):
        pg = doc.load_page(i)
        st = time.perf_counter()
        try:
            if not _need_ocr(pg):
                txt = pg.get_text("text") or ""
                parts_wrapped.append(_wrap_page_header(i + 1, total, txt))
                parts_noheader.append((txt or "").strip())
                engines.append("fitz.text")
                pages.append(PageInfo(index=i, source="pdf-text", chars=len(txt), secs=time.perf_counter() - st, note="fitz.text"))
                continue

            if Image is None:
                parts_wrapped.append(_wrap_page_header(i + 1, total, ""))
                parts_noheader.append("")
                pages.append(PageInfo(index=i, source="skipped", chars=0, secs=time.perf_counter() - st, note="NO_IMAGE_LIB"))
                engines.append("skipped")
                continue

            bbox = pg.rect
            eff = _eff_zoom_with_limit(base_zoom, bbox.width, bbox.height, pixel_limit)
            pix = pg.get_pixmap(matrix=fitz.Matrix(eff, eff), alpha=False, colorspace=fitz.csRGB)

            # ✅ PNG-less path: dựng PIL Image trực tiếp từ buffer pixmap (nhanh hơn)
            import numpy as _np
            _arr = _np.frombuffer(pix.samples, dtype=_np.uint8)
            _arr = _arr.reshape(pix.h, pix.w, pix.n)
            if pix.n == 4:
                _arr = _arr[:, :, :3]  # bỏ alpha nếu có
            pil = Image.fromarray(_arr, mode="RGB")

            txt, conf, used = _ocr_with_backend_pil(pil, lang_combo=lang)

            # VI “rác” → thử engine khác hoặc upscale lần 2
            if _vi_ocr_looks_bad(txt, lang):
                alt_txt, alt_conf, alt_used = txt, conf, used
                try:
                    if used == "tesseract" and easyocr is not None:
                        alt_txt, alt_conf = _easyocr_read_pil(pil, _langs_for_easyocr(lang)); alt_used = "easyocr"
                    elif used == "easyocr" and pytesseract is not None:
                        alt_txt, alt_conf = _ocr_pil_tesseract(pil, lang=lang); alt_used = "tesseract"
                except Exception:
                    pass

                def _score(s: str) -> float:
                    d, a = _vi_quality_metrics(s)
                    return d - 0.2 * max(0.0, a - 0.9)

                if (_score(alt_txt) > _score(txt)) or (len(alt_txt) > len(txt) * 1.2):
                    txt, conf, used = alt_txt, alt_conf, alt_used
                else:
                    try:
                        eff2 = min(_eff_zoom_with_limit(eff * 1.5, bbox.width, bbox.height, pixel_limit), 400.0 / 72.0)
                        if eff2 > eff * 1.01:
                            pix2 = pg.get_pixmap(matrix=fitz.Matrix(eff2, eff2), alpha=False, colorspace=fitz.csRGB)
                            _arr2 = _np.frombuffer(pix2.samples, dtype=_np.uint8).reshape(pix2.h, pix2.w, pix2.n)
                            if pix2.n == 4:
                                _arr2 = _arr2[:, :, :3]
                            pil2 = Image.fromarray(_arr2, mode="RGB")
                            t2, c2, u2 = _ocr_with_backend_pil(pil2, lang_combo=lang)
                            if _score(t2) >= _score(txt):
                                txt, conf, used = t2, c2, u2
                    except Exception:
                        pass

            body = (txt or "").strip()

            if DROP_NOISE_PAGES:
                d, a = _vi_quality_metrics(body)
                if len(body) >= NOISE_MINLEN and a >= NOISE_ASCII_RATIO and d <= NOISE_DIACRITIC:
                    body = ""

            parts_wrapped.append(_wrap_page_header(i + 1, total, body))
            parts_noheader.append(body)
            ocr_pages += 1
            engines.append(used)
            pages.append(
                PageInfo(
                    index=i,
                    source="ocr",
                    chars=len(body),
                    secs=time.perf_counter() - st,
                    dpi=int(72 * eff),
                    avg_conf=None if conf is None else float(conf),
                    note=used,
                )
            )
            if OCR_DEBUG:
                logger.debug("Page %d/%d used %s", i + 1, total, used)
        except Exception as e:
            engines.append("error")
            pages.append(PageInfo(index=i, source="error", chars=0, secs=time.perf_counter() - st, note=str(e)))
            parts_wrapped.append(_wrap_page_header(i + 1, total, ""))
            parts_noheader.append("")
            continue

    doc.close()

    parts_wrapped = _apply_post_filters(parts_wrapped)

    # ✅ Build full + tính page_spans (map trang → [start,end)) dựa trên parts_wrapped
    builder = ""
    spans_tmp: list[dict[str, int]] = []
    for idx, body in enumerate(parts_wrapped):
        if idx > 0:
            builder += "\n\n"  # đúng cách join hiện tại
        start = len(builder)
        builder += (body or "")
        end = len(builder)
        spans_tmp.append({"page": idx + 1, "start": start, "end": end})

    # strip như logic cũ, rồi hiệu chỉnh spans tương ứng
    strip_left = len(builder) - len(builder.lstrip())
    strip_right = len(builder) - len(builder.rstrip())
    full = builder.strip()

    def _adjust_span(s: dict[str, int]) -> dict[str, int]:
        lo = max(0, s["start"] - strip_left)
        hi_raw_end = len(builder) - strip_right
        hi = max(0, min(hi_raw_end, s["end"]) - strip_left)
        if hi < lo:
            hi = lo
        return {"page": s["page"], "start": lo, "end": hi}

    page_spans = [_adjust_span(s) for s in spans_tmp]

    pdf_text_pages = max(0, total - ocr_pages)
    return full, pages, total, ocr_pages, "+".join(sorted(set(engines)) or ["unknown"]), page_spans, parts_noheader

def _image_ocr(file_path: str, *, lang: str) -> tuple[str, list[PageInfo], int, int, str, list[str]]:
    if Image is None:
        raise RuntimeError("Thiếu Pillow để OCR ảnh.")
    st = time.perf_counter()
    with Image.open(file_path) as im:
        img = im.convert("RGB")
        try:
            if ImageOps:
                img = ImageOps.exif_transpose(img)
        except Exception:
            pass
        txt, conf, used = _ocr_with_backend_pil(img, lang_combo=lang)
    secs = time.perf_counter() - st
    body = (txt or "").strip()
    wrapped = _wrap_page_header(1, 1, body) if PAGE_MARK_ENABLE else body
    return (
        wrapped,
        [PageInfo(index=0, source="image-ocr", chars=len(body), secs=secs, avg_conf=None if conf is None else float(conf), note=used)],
        1,
        1 if body else 0,
        used,
        [body],
    )

# ── Public API ────────────────────────────────────────────────────────────────
def extract_text(
    file_path: str,
    *,
    lang: str | None = None,
    dpi: int | None = None,
    max_pages: int | None = None,
    ocr_all: bool | None = None,
    cache_dir: str | None = None,
    write_meta: bool = True,  # kept for API compatibility (unused externally)
    ext: str | None = None,   # ditto
) -> OCRResult:
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)
    _lang = (lang or (OCR_PDF_LANG if _is_pdf(file_path) else OCR_IMG_LANG)).strip() or "vie+eng"
    _dpi = int(dpi or OCR_MIN_DPI)
    _max = int(max_pages or OCR_MAX_PAGES)
    _ocr_all = bool(OCR_FORCE_OCR_ALL if ocr_all is None else ocr_all)
    _cache = os.path.abspath(cache_dir or OCR_CACHE_DIR)

    sha1 = _sha1_file(file_path)
    base = os.path.join(_cache, sha1[:2], sha1)
    text_path = base + ".txt"
    meta_path = base + ".json"
    _ensure_dir(os.path.dirname(text_path))

    # cache
    if os.path.exists(text_path):
        try:
            text_cached = _read_text(text_path)
            total_pages = ocr_pages = pdf_text_pages = 0
            engine = "cache"
            pages: list[PageInfo] = []
            avg_conf = None
            page_spans: list[dict[str, int]] | None = None
            pages_text: list[str] | None = None
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as mf:
                        meta = json.load(mf)
                    total_pages = _safe_int(meta.get("total_pages"), 0)
                    ocr_pages = _safe_int(meta.get("ocr_pages"), 0)
                    pdf_text_pages = _safe_int(meta.get("pdf_text_pages"), 0)
                    engine = str(meta.get("engine") or "cache")
                    avg_conf = meta.get("avg_confidence", None)
                    page_spans = meta.get("page_spans")
                    raw_pages = meta.get("pages") or []
                    for p in raw_pages:
                        pages.append(
                            PageInfo(
                                index=_safe_int(p.get("index"), 0),
                                source=str(p.get("source") or ""),
                                chars=_safe_int(p.get("chars"), 0),
                                secs=float(p.get("secs") or 0.0),
                                dpi=_safe_int_or_none(p.get("dpi")),
                                note=p.get("note"),
                                avg_conf=p.get("avg_conf"),
                            )
                        )
                    # Ưu tiên đọc sẵn pages_text; nếu không có, dựng lại từ spans
                    pages_text = meta.get("pages_text")
                    if (not pages_text) and page_spans:
                        pages_text = []
                        for s in page_spans:
                            seg = text_cached[s["start"] : s["end"]]
                            if PAGE_MARK_ENABLE and seg.startswith("="):
                                seg = seg.split("\n", 1)[1] if "\n" in seg else ""
                            pages_text.append(seg.strip())
                    # Đồng bộ độ dài nếu cần
                    if pages_text and total_pages and len(pages_text) != total_pages:
                        # co giãn an toàn
                        if len(pages_text) > total_pages:
                            pages_text = pages_text[:total_pages]
                        else:
                            pages_text = pages_text + [""] * (total_pages - len(pages_text))
                except Exception:
                    pass
            dia, asc = _vi_quality_metrics(text_cached)
            return OCRResult(
                True,
                text_cached,
                text_path,
                True,
                total_pages,
                ocr_pages,
                pdf_text_pages,
                pages,
                engine,
                is_pdf=_is_pdf(file_path),
                page_spans=page_spans,
                pages_text=pages_text,
                meta_path=meta_path if os.path.exists(meta_path) else None,
                avg_confidence=avg_conf,
                diacritic_ratio=dia,
                ascii_word_ratio=asc,
            )
        except Exception:
            pass

    # run
    try:
        if _is_pdf(file_path):
            full_raw, pages, total, ocrn, engine, page_spans, parts_noheader = _pdf_extract_text_or_ocr(
                file_path,
                lang=_lang,
                dpi=_dpi,
                max_pages=_max,
                ocr_all=_ocr_all,
                text_threshold=OCR_TEXT_THRESHOLD,
                pixel_limit=OCR_PIXEL_LIMIT,
            )
            pdf_text_pages = max(0, total - ocrn)
            # Hậu xử lý theo TRANG để có pages_text
            pages_text_pp: list[str] = []
            for body in parts_noheader:
                t = _normalize_vi_text(body)
                t = _post_process(t) if POST_ENABLE else t
                pages_text_pp.append(t)
            # Build full text từ pages_text_pp (kèm header theo config)
            joined_parts = [_wrap_page_header(i + 1, total, pages_text_pp[i]) for i in range(total)]
            text_norm = "\n\n".join(joined_parts).strip()
            # Cập nhật spans dựa trên text đã hậu xử lý
            spans_fixed: list[dict[str, int]] = []
            pos = 0
            for i, part in enumerate(joined_parts):
                start = pos
                pos += len(part)
                spans_fixed.append({"page": i + 1, "start": start, "end": pos})
                if i < len(joined_parts) - 1:
                    pos += 2  # cho "\n\n"
            page_spans = spans_fixed
        elif _is_image(file_path):
            full_raw, pages, total, ocrn, engine, parts_noheader = _image_ocr(file_path, lang=_lang)
            pdf_text_pages = 0
            # Hậu xử lý 1 trang
            t = _normalize_vi_text(parts_noheader[0])
            t = _post_process(t) if POST_ENABLE else t
            pages_text_pp = [t]
            text_norm = _wrap_page_header(1, 1, t) if PAGE_MARK_ENABLE else t
            page_spans = [{"page": 1, "start": 0, "end": len(text_norm)}]
        else:
            raise RuntimeError("Định dạng tệp không hỗ trợ OCR.")
    except Exception as e:
        logger.exception("OCR failed: %s", e)
        return OCRResult(
            False,
            "",
            None,
            False,
            0,
            0,
            0,
            [],
            engine=f"error:{type(e).__name__}",
            is_pdf=_is_pdf(file_path),
            page_spans=None,
            pages_text=None,
            meta_path=None,
            avg_confidence=None,
            diacritic_ratio=None,
            ascii_word_ratio=None,
            error=str(e),
        )

    # Metrics
    dia, asc = _vi_quality_metrics(text_norm)
    confs = [p.avg_conf for p in pages if p.source in ("ocr", "image-ocr") and isinstance(p.avg_conf, (int, float))]
    avg_conf_tot = (sum(float(c) for c in confs) / len(confs)) if confs else None

    # Cache write
    try:
        _write_text(text_path, text_norm)
        meta_obj = {
            "file_name": os.path.basename(file_path),
            "sha1": sha1,
            "engine": engine,
            "total_pages": total,
            "ocr_pages": ocrn,
            "pdf_text_pages": pdf_text_pages,
            "pages": [asdict(p) for p in pages],
            "page_spans": page_spans,    # ✅ lưu map trang → offset
            "pages_text": pages_text_pp, # ✅ lưu text theo trang (đÃ hậu xử lý)
            "created_at": int(time.time()),
            "lang": _lang,
            "dpi": _dpi,
            "max_pages": _max,
            "ocr_all": _ocr_all,
            "python": sys.version.split()[0],
            "avg_confidence": avg_conf_tot,
            "diacritic_ratio": dia,
            "ascii_word_ratio": asc,
            "post": {
                "enabled": POST_ENABLE,
                "clean_enable": POST_CLEAN_ENABLE,
                "mark_noinhan": POST_MARK_NOINHAN,
                "collapse_noinhan": POST_NOINHAN_COLLAPSE,
                "keep_punct": POST_KEEP_PUNCT,
                "noinhan_max_dist": NOINHAN_MAX_DIST,
                "noinhan_max_lines": NOINHAN_MAX_LINES,
                "page_mark_enable": PAGE_MARK_ENABLE,
                "page_mark_fmt": PAGE_MARK_FMT,
                "join_lowercase_cont": JOIN_LOWERCASE_CONT,
                "drop_noise_pages": DROP_NOISE_PAGES,
                "noise_ascii_ratio": NOISE_ASCII_RATIO,
                "noise_diacritic": NOISE_DIACRITIC,
                "noise_minlen": NOISE_MINLEN,
                "drop_repeat_lines": DROP_REPEAT_LINES,
                "repeat_min_freq": REPEAT_MIN_FREQ,
                "corr_json": CORR_JSON or None,
            },
            "diag": _gpu_diag() if OCR_DEBUG else None,
        }
        _ensure_dir(os.path.dirname(meta_path))
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta_obj, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning("Không thể ghi cache OCR: %s", e)
        meta_path = None  # noqa: F841

    return OCRResult(
        True,
        text_norm,
        text_path,
        False,
        total,
        ocrn,
        pdf_text_pages,
        pages,
        engine,
        is_pdf=_is_pdf(file_path),
        page_spans=page_spans,
        pages_text=pages_text_pp,
        meta_path=meta_path if ("meta_path" in locals() and meta_path and os.path.exists(meta_path)) else None,
        avg_confidence=avg_conf_tot,
        diacritic_ratio=dia,
        ascii_word_ratio=asc,
        error=None,
    )

# ── Page span helpers (dùng trong RAG/QA) ─────────────────────────────────────
def page_for_pos(page_spans: list[dict[str, int]] | None, pos: int) -> int | None:
    if not page_spans:
        return None
    for s in page_spans:
        if s["start"] <= pos < s["end"]:
            return s["page"]
    return None

def pages_for_range(page_spans: list[dict[str, int]] | None, start: int, end: int) -> list[int]:
    if not page_spans:
        return []
    out: list[int] = []
    for s in page_spans:
        if max(start, s["start"]) < min(end, s["end"]):  # giao nhau
            out.append(s["page"])
    return sorted(set(out))

def guess_pages_from_snippet(text: str, page_spans: list[dict[str, int]] | None, snippet: str, fuzz: int = 64) -> list[int]:
    """
    Ước lượng trang từ 1 đoạn trích; thử tìm vị trí xuất hiện rồi map sang page_spans.
    """
    if not page_spans:
        return []
    snippet = (snippet or "").strip()
    if not snippet:
        return []
    probe = snippet[: max(16, min(len(snippet), 256))]
    pos = text.find(probe)
    if pos == -1 and len(snippet) > 80:
        probe2 = snippet[-max(16, min(len(snippet) // 3, 256)) :]
        pos = text.find(probe2)
    if pos == -1:
        return []
    return pages_for_range(page_spans, max(0, pos - fuzz), min(len(text), pos + len(probe) + fuzz))

# ── Async ─────────────────────────────────────────────────────────────────────
async def extract_text_async(*args, **kwargs) -> OCRResult:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: extract_text(*args, **kwargs))

# ── Metrics (optional) ────────────────────────────────────────────────────────
def _lev_ed(r: str, h: str) -> int:
    n, m = len(r), len(h)
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return dp[m]

def cer(ref: str, hyp: str) -> float:
    r = _normalize_vi_text(ref)
    h = _normalize_vi_text(hyp)
    return _lev_ed(r, h) / max(1, len(r))

def wer(ref: str, hyp: str) -> float:
    r = re.findall(r"\w+", _normalize_vi_text(ref))
    h = re.findall(r"\w+", _normalize_vi_text(hyp))
    n, m = len(r), len(h)
    dp = list(range(m + 1))
    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            cur = dp[j]
            dp[j] = min(dp[j] + 1, dp[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return dp[m] / max(1, n)

if __name__ == "__main__":  # pragma: no cover
    import argparse
    ap = argparse.ArgumentParser(description="DocAIx OCR (VI-tuned) – Quick CLI")
    ap.add_argument("file", nargs="?", help="Đường dẫn PDF/ảnh")
    ap.add_argument("--lang", default=None)
    ap.add_argument("--dpi", type=int, default=None)
    ap.add_argument("--max-pages", type=int, default=None)
    ap.add_argument("--ocr-all", action="store_true")
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--eval", help="Ground-truth .txt để tính CER/WER")
    ap.add_argument("--diag", action="store_true", help="In thông tin CUDA/EasyOCR/Tesseract")
    args = ap.parse_args()

    if args.diag:
        print(json.dumps(_gpu_diag(), ensure_ascii=False, indent=2))
        sys.exit(0)

    if not args.file:
        ap.error("Thiếu đường dẫn file")

    res = extract_text(
        args.file,
        lang=args.lang,
        dpi=args.dpi,
        max_pages=args.max_pages,
        ocr_all=True if args.ocr_all else None,
        cache_dir=args.cache_dir,
    )
    print(res.to_json())
    if args.eval and os.path.isfile(args.eval):
        with open(args.eval, "r", encoding="utf-8") as f:
            gt = f.read()
        print(
            json.dumps(
                {"CER": cer(gt, res.text), "WER": wer(gt, res.text), "diacritic_ratio": _vi_quality_metrics(res.text)[0]},
                ensure_ascii=False,
                indent=2,
            )
        )
