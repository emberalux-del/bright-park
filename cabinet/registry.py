"""Read the first sheet of a registry or a CSV exported from Excel."""
import csv
import io
import json
import sys
import zipfile

from openpyxl import load_workbook

payload = sys.stdin.buffer.read(2_000_001)
if len(payload) > 2_000_000:
    sys.exit(1)

try:
    if sys.argv[1] == ".xlsx":
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            if sum(item.file_size for item in archive.infolist()) > 12_000_000:
                sys.exit(1)
        workbook = load_workbook(io.BytesIO(payload), read_only=True, data_only=True)
        rows = workbook.worksheets[0].iter_rows(values_only=True)
    else:
        source = payload.decode("utf-8-sig")
        header = source.splitlines()[0]
        separator = ";" if ";" in header else "," if "," in header else "\t"
        rows = csv.reader(io.StringIO(source), delimiter=separator)
    header = [str(cell or "").strip().lower() for cell in next(rows)]
    phone_column = next(i for i, name in enumerate(header) if name in {"телефон", "номер телефона", "phone"})
    plot_column = next(i for i, name in enumerate(header) if name in {"участок", "номер участка", "plot"})
    result = []
    for number, row in enumerate(rows, 2):
        if number > 2001:
            sys.exit(1)
        if not any(cell is not None and str(cell).strip() for cell in row):
            continue
        values = [row[i] if i < len(row) else None for i in (phone_column, plot_column)]
        result.append([number, *(str(value).strip() if value is not None else "" for value in values)])
    print(json.dumps(result, ensure_ascii=True))
except Exception:
    sys.exit(1)
