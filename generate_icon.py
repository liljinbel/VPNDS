import math
from PIL import Image, ImageDraw, ImageFilter

def make_frosted_icon():
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # 1. Subtle Outer White/Silver Glow
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_glow = ImageDraw.Draw(glow)
    
    shield_pts = [
        (44, 38),
        (128, 22),
        (212, 38),
        (214, 122),
        (178, 186),
        (128, 234),
        (78, 186),
        (42, 122)
    ]
    
    # Outer silver/white ethereal glow
    draw_glow.polygon(shield_pts, fill=(255, 255, 255, 90))
    glow = glow.filter(ImageFilter.GaussianBlur(16))
    img.paste(glow, (0, 0), glow)

    draw = ImageDraw.Draw(img)

    # 2. Shield Outer Dark Rim (Frosted Obsidian)
    draw.polygon(shield_pts, fill=(18, 18, 22, 255), outline=(120, 120, 130, 220))

    # 3. Inner Shield Face (Frosted Glass Gradient effect)
    inner_pts = [
        (54, 48),
        (128, 34),
        (202, 48),
        (204, 118),
        (172, 176),
        (128, 220),
        (84, 176),
        (52, 118)
    ]
    draw.polygon(inner_pts, fill=(28, 28, 34, 255), outline=(220, 220, 230, 160))

    # 4. Glass Reflection diagonal sheen on top half
    sheen = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_sheen = ImageDraw.Draw(sheen)
    sheen_pts = [
        (54, 48),
        (128, 34),
        (160, 41),
        (52, 118)
    ]
    draw_sheen.polygon(sheen_pts, fill=(255, 255, 255, 35))
    sheen = sheen.filter(ImageFilter.GaussianBlur(3))
    img.paste(sheen, (0, 0), sheen)

    # 5. Core Minimalist Shield Center (Deep Titanium)
    core_pts = [
        (66, 60),
        (128, 48),
        (190, 60),
        (192, 114),
        (164, 164),
        (128, 204),
        (92, 164),
        (64, 114)
    ]
    draw.polygon(core_pts, fill=(12, 12, 15, 255), outline=(70, 70, 80, 255))

    # 6. Futuristic Minimalist Monogram: Clean Geometric "V" + Lightning / Key emblem
    # Pure High-Contrast White & Silver
    v_pts = [
        (86, 76),
        (104, 76),
        (128, 146),
        (152, 76),
        (170, 76),
        (138, 168),
        (118, 168)
    ]
    
    # White Glow for emblem
    v_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_vglow = ImageDraw.Draw(v_glow)
    draw_vglow.polygon(v_pts, fill=(255, 255, 255, 180))
    v_glow = v_glow.filter(ImageFilter.GaussianBlur(6))
    img.paste(v_glow, (0, 0), v_glow)

    # Draw pure crisp white V
    draw.polygon(v_pts, fill=(255, 255, 255, 255), outline=(220, 220, 230, 255))

    # Center pulse node / DNS dot (Silver/White illuminated orb)
    node_x, node_y, r = 128, 186, 6
    draw.ellipse([node_x - r - 3, node_y - r - 3, node_x + r + 3, node_y + r + 3], fill=(255, 255, 255, 60))
    draw.ellipse([node_x - r, node_y - r, node_x + r, node_y + r], fill=(255, 255, 255, 255), outline=(180, 180, 190, 255))

    # Subtle connecting beam from V tip to node
    draw.line([(128, 168), (128, 180)], fill=(255, 255, 255, 200), width=2)

    # Lateral satellite nodes (clean minimal geometry)
    for (nx, ny) in [(96, 114), (160, 114)]:
        draw.ellipse([nx-3, ny-3, nx+3, ny+3], fill=(200, 200, 210, 255))

    # 7. Generate multi-resolution ICO file
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    icons = []
    for s in sizes:
        resampled = img.resize(s, Image.Resampling.LANCZOS)
        icons.append(resampled)

    icons[0].save("app_vpnds.ico", format="ICO", sizes=[(s[0], s[1]) for s in sizes], append_images=icons[1:])
    try:
        icons[0].save("app.ico", format="ICO", sizes=[(s[0], s[1]) for s in sizes], append_images=icons[1:])
    except Exception as e:
        pass
    img.save("app_preview.png")
    print("Novo icone app_vpnds.ico (Preto & Branco / Vidro Fosco) gerado com sucesso!")

if __name__ == "__main__":
    make_frosted_icon()
