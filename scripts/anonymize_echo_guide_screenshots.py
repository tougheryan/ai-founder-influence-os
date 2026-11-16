from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


SOURCE_DIR = Path("/private/tmp/echo-founder-user-guide")
OUTPUT_DIR = Path("/private/tmp/echo-founder-user-guide-anonymized")
FONT_PATH = Path("/private/tmp/echo-fonts/ArialUnicode.ttf")


def blur(image: Image.Image, box: tuple[int, int, int, int], radius: int = 4) -> None:
    crop = image.crop(box)
    image.paste(crop.filter(ImageFilter.GaussianBlur(radius=radius)), box)


def fill_and_label(
    image: Image.Image,
    box: tuple[int, int, int, int],
    label: str,
    *,
    size: int = 14,
    color: str = "#334155",
) -> None:
    draw = ImageDraw.Draw(image)
    draw.rectangle(box, fill="#F8FAF9")
    font = ImageFont.truetype(str(FONT_PATH), size)
    draw.text((box[0] + 5, box[1] + 3), label, font=font, fill=color)


def anonymize_settings(image: Image.Image) -> None:
    # Provider value and project/runtime identifiers are not required for the
    # operating instructions. Keep the screen real while removing deploy- and
    # vendor-specific identifiers from the deliverable.
    fill_and_label(image, (864, 243, 952, 271), "已配置", size=12)
    blur(image, (355, 405, 880, 465), radius=5)
    blur(image, (682, 540, 960, 748), radius=5)
    fill_and_label(image, (982, 588, 1094, 614), "已配置", size=12)
    blur(image, (982, 642, 1180, 674), radius=5)


def anonymize_delivery_center(image: Image.Image) -> None:
    fill_and_label(image, (315, 241, 481, 271), "本期任务", size=16, color="#1F2937")
    fill_and_label(image, (315, 279, 580, 310), "任务信息已匿名", size=12, color="#64748B")
    fill_and_label(image, (315, 382, 500, 416), "多渠道发布交付", size=16, color="#334155")
    blur(image, (315, 817, 485, 841), radius=5)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for source in SOURCE_DIR.glob("*-annotated.png"):
        image = Image.open(source).convert("RGBA")
        if source.name == "05-settings-annotated.png":
            anonymize_settings(image)
        elif source.name == "06-delivery-center-annotated.png":
            anonymize_delivery_center(image)
        image.convert("RGB").save(OUTPUT_DIR / source.name, optimize=True)
        print(OUTPUT_DIR / source.name)


if __name__ == "__main__":
    main()
