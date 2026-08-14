"""Build and export the Aurora hero scene with Blender.

Run with:
  blender --background --python tools/blender/create_aurora_hero.py
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "public" / "3d"
ASSET_DIR = ROOT / "tools" / "blender" / "assets"
BLEND_PATH = OUTPUT_DIR / "aurora-hero-v2.blend"
GLB_PATH = OUTPUT_DIR / "aurora-hero-v2.glb"
POSTER_PATH = OUTPUT_DIR / "aurora-hero-v2-poster.png"
FRAME_END = 240


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    metallic: float = 0.0,
    roughness: float = 0.35,
    coat: float = 0.0,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.16
    if emission is not None:
        emission_input = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[emission_input].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def assign_material(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def rounded_box(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    bevel: float,
    mat: bpy.types.Material,
    *,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    segments: int = 8,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new(name="Soft bevel", type="BEVEL")
    modifier.width = bevel
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    modifier.affect = "EDGES"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    assign_material(obj, mat)
    return obj


def extruded_polygon(
    name: str,
    points: list[tuple[float, float]],
    y_front: float,
    depth: float,
    mat: bpy.types.Material,
    *,
    bevel: float = 0.04,
) -> bpy.types.Object:
    y_back = y_front + depth
    vertices = [(x, y_front, z) for x, z in points] + [(x, y_back, z) for x, z in points]
    count = len(points)
    faces: list[tuple[int, ...]] = []
    faces.append(tuple(range(count)))
    faces.append(tuple(range(count, count * 2))[::-1])
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(f"{name}Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    assign_material(obj, mat)
    if bevel > 0:
        modifier = obj.modifiers.new(name="Edge bevel", type="BEVEL")
        modifier.width = bevel
        modifier.segments = 3
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def create_text(
    name: str,
    text: str,
    location: tuple[float, float, float],
    size: float,
    mat: bpy.types.Material,
    *,
    extrude: float = 0.055,
) -> bpy.types.Object:
    data = bpy.data.curves.new(name=f"{name}Curve", type="FONT")
    data.body = text
    data.align_x = "CENTER"
    data.align_y = "CENTER"
    data.size = size
    data.extrude = extrude
    data.bevel_depth = 0.012
    data.bevel_resolution = 2
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (math.radians(90), 0.0, 0.0)
    assign_material(obj, mat)
    return obj


def import_svg_shape(
    name: str,
    filename: str,
    location: tuple[float, float, float],
    target_height: float,
    depth: float,
    mat: bpy.types.Material,
    *,
    bevel: float = 0.025,
) -> bpy.types.Object:
    """Import one brand SVG as an extruded, front-facing Blender object."""
    before = set(bpy.context.scene.objects)
    bpy.ops.import_curve.svg(filepath=str(ASSET_DIR / filename))
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    if not imported:
        raise RuntimeError(f"Unable to import {filename}")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in imported:
        obj.data.dimensions = "2D"
        obj.data.resolution_u = 20
        obj.data.extrude = depth
        obj.data.bevel_depth = bevel
        obj.data.bevel_resolution = 3
        obj.select_set(True)

    bpy.context.view_layer.objects.active = imported[0]
    if len(imported) > 1:
        bpy.ops.object.join()
    bpy.ops.object.convert(target="MESH")
    shape = bpy.context.object
    shape.name = name
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    source_height = shape.dimensions.y
    source_depth = max(shape.dimensions.z, 1e-6)
    scale_xy = target_height / source_height
    shape.scale = (scale_xy, scale_xy, depth / source_depth)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    shape.rotation_euler = (math.radians(90), 0.0, 0.0)
    shape.location = location
    assign_material(shape, mat)
    return shape


def create_ring(
    name: str,
    radius_x: float,
    radius_z: float,
    depth_y: float,
    tilt: float,
    mat: bpy.types.Material,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name=f"{name}Curve", type="CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = 0.008
    curve.bevel_resolution = 3
    spline = curve.splines.new("POLY")
    points = 160
    spline.points.add(points - 1)
    for index in range(points):
        angle = math.tau * index / points
        x = radius_x * math.cos(angle)
        z = radius_z * math.sin(angle) + 0.28 * math.sin(angle * 2 + tilt)
        y = depth_y * math.sin(angle + tilt)
        spline.points[index].co = (x, y, z, 1.0)
    spline.use_cyclic_u = True
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    assign_material(obj, mat)
    return obj


def create_display_a(parent: bpy.types.Object, mat: bpy.types.Material) -> None:
    """Build the hero letter from clean beveled strokes to avoid SVG tessellation artifacts."""
    strokes = (
        (
            "Aurora A left stroke",
            [(-1.6, -1.62), (-0.76, -1.62), (0.34, 1.66), (-0.36, 1.66)],
        ),
        (
            "Aurora A right stroke",
            [(1.6, -1.62), (0.76, -1.62), (-0.34, 1.66), (0.36, 1.66)],
        ),
        (
            "Aurora A crossbar",
            [(-0.86, -0.34), (0.86, -0.34), (0.66, 0.28), (-0.66, 0.28)],
        ),
    )
    for name, points in strokes:
        stroke = extruded_polygon(name, points, -0.94, 0.16, mat, bevel=0.055)
        stroke.parent = parent


def create_badge_icon(
    parent: bpy.types.Object,
    kind: str,
    white: bpy.types.Material,
    blue: bpy.types.Material,
    badge_mat: bpy.types.Material,
    tiktok_cyan: bpy.types.Material,
    tiktok_red: bpy.types.Material,
) -> None:
    if kind == "instagram":
        frame = rounded_box(
            "Instagram camera frame",
            (0.0, -0.255, 0.0),
            (0.82, 0.09, 0.82),
            0.2,
            white,
            segments=10,
        )
        frame.parent = parent
        inset = rounded_box(
            "Instagram camera inset",
            (0.0, -0.315, 0.0),
            (0.62, 0.055, 0.62),
            0.14,
            badge_mat,
            segments=10,
        )
        inset.parent = parent
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.18,
            minor_radius=0.045,
            major_segments=32,
            minor_segments=8,
            location=(0.0, -0.36, 0.0),
            rotation=(math.radians(90), 0.0, 0.0),
        )
        ring = bpy.context.object
        ring.name = "Instagram lens"
        assign_material(ring, white)
        ring.parent = parent
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.052, location=(0.22, -0.375, 0.22))
        dot = bpy.context.object
        dot.name = "Instagram dot"
        assign_material(dot, white)
        dot.parent = parent
    elif kind == "telegram":
        shape = [(-0.38, 0.18), (0.4, 0.42), (0.17, -0.42), (-0.02, -0.08)]
        icon = extruded_polygon("Telegram plane", shape, -0.28, 0.07, white, bevel=0.025)
        icon.parent = parent
    elif kind == "youtube":
        shape = [(-0.23, -0.34), (-0.23, 0.34), (0.38, 0.0)]
        icon = extruded_polygon("YouTube play", shape, -0.28, 0.07, white, bevel=0.025)
        icon.parent = parent
    elif kind == "vk":
        label = create_text("VK monogram", "VK", (0.0, -0.29, 0.0), 0.48, white)
        label.parent = parent
    elif kind == "tiktok":
        cyan_note = create_text("TikTok cyan note", "♪", (-0.055, -0.285, -0.025), 0.78, tiktok_cyan)
        cyan_note.parent = parent
        red_note = create_text("TikTok red note", "♪", (0.055, -0.3, 0.025), 0.78, tiktok_red)
        red_note.parent = parent
        label = create_text("TikTok white note", "♪", (0.0, -0.325, 0.0), 0.78, white)
        label.parent = parent
    elif kind == "ok":
        label = create_text("OK monogram", "OK", (0.0, -0.29, 0.0), 0.42, white)
        label.parent = parent


def set_linear_animation(obj: bpy.types.Object) -> None:
    if not obj.animation_data or not obj.animation_data.action:
        return
    action = obj.animation_data.action
    # Blender 5 stores freshly keyed curves in layered actions. The exporter
    # handles both layouts, while older Blender releases still expose fcurves.
    for fcurve in getattr(action, "fcurves", []):
        for point in fcurve.keyframe_points:
            point.interpolation = "LINEAR"


def look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def build_scene() -> None:
    clear_scene()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    blue = material("Aurora blue", (0.028, 0.205, 1.0, 1.0), metallic=0.06, roughness=0.28, coat=0.34)
    blue_side = material("Aurora edge", (0.008, 0.07, 0.53, 1.0), metallic=0.12, roughness=0.29, coat=0.3)
    blue_mark = material("Aurora mark blue", (0.012, 0.145, 0.86, 1.0), metallic=0.01, roughness=0.25)
    white = material("Soft white", (0.99, 0.995, 1.0, 1.0), metallic=0.01, roughness=0.19, coat=0.3)
    star_white = material(
        "Star white",
        (1.0, 1.0, 1.0, 1.0),
        roughness=0.24,
        emission=(1.0, 1.0, 1.0, 1.0),
        emission_strength=0.18,
    )
    orbit_mat = material(
        "Orbit light",
        (0.34, 0.56, 1.0, 1.0),
        roughness=0.32,
        emission=(0.12, 0.32, 1.0, 1.0),
        emission_strength=0.08,
    )
    badge_materials = {
        "instagram": material("Instagram", (0.94, 0.05, 0.32, 1.0), metallic=0.02, roughness=0.32, coat=0.28),
        "telegram": material("Telegram", (0.02, 0.52, 0.93, 1.0), metallic=0.02, roughness=0.31, coat=0.27),
        "youtube": material("YouTube", (0.95, 0.01, 0.035, 1.0), metallic=0.02, roughness=0.31, coat=0.27),
        "vk": material("VK", (0.04, 0.37, 0.86, 1.0), metallic=0.02, roughness=0.32, coat=0.27),
        "tiktok": material("TikTok", (0.008, 0.012, 0.026, 1.0), metallic=0.1, roughness=0.28, coat=0.32),
        "ok": material("OK", (1.0, 0.31, 0.025, 1.0), metallic=0.02, roughness=0.32, coat=0.27),
    }
    tiktok_cyan = material("TikTok cyan", (0.0, 0.93, 0.94, 1.0), roughness=0.24, coat=0.2)
    tiktok_red = material("TikTok red", (1.0, 0.015, 0.31, 1.0), roughness=0.24, coat=0.2)

    core = bpy.data.objects.new("Aurora Core", None)
    bpy.context.collection.objects.link(core)

    back = rounded_box("Aurora dark edge", (0.26, 0.38, -0.2), (5.72, 1.5, 5.72), 0.76, blue_side, segments=14)
    back.parent = core
    body = rounded_box("Aurora body", (0.0, -0.22, 0.0), (5.72, 1.34, 5.72), 0.78, blue, segments=14)
    body.parent = core

    create_display_a(core, white)
    center_star = import_svg_shape(
        "Aurora center star",
        "aurora-star.svg",
        (0.0, -1.14, -0.04),
        0.78,
        0.055,
        blue_mark,
        bevel=0.018,
    )
    center_star.parent = core
    star = import_svg_shape(
        "Aurora star",
        "aurora-star.svg",
        (1.65, -1.09, 1.48),
        0.82,
        0.075,
        star_white,
        bevel=0.018,
    )
    star.parent = core

    create_ring("Rear orbit", 7.45, 2.16, 1.3, 0.2, orbit_mat)
    create_ring("Front orbit", 7.75, 2.5, 1.55, -0.38, orbit_mat)

    badge_specs = [
        ("instagram", (-5.25, 0.55, 2.25), 1.52, math.radians(-6), 0.14),
        ("telegram", (5.35, 0.72, 2.72), 1.54, math.radians(7), 0.18),
        ("tiktok", (3.88, -0.72, -0.85), 1.5, math.radians(-7), 0.12),
        ("ok", (5.8, -0.18, -2.5), 1.46, math.radians(6), 0.14),
        ("youtube", (-3.72, -0.82, -2.72), 1.52, math.radians(-5), 0.16),
        ("vk", (-5.72, 0.25, -1.12), 1.48, math.radians(4), 0.12),
    ]
    for badge_index, (kind, base_location, badge_size, base_rotation, bob) in enumerate(badge_specs):
        anchor = bpy.data.objects.new(f"{kind.title()} orbit anchor", None)
        bpy.context.collection.objects.link(anchor)
        badge = rounded_box(
            f"{kind.title()} badge",
            (0.0, 0.0, 0.0),
            (badge_size, 0.46, badge_size),
            0.34,
            badge_materials[kind],
            segments=12,
        )
        badge.parent = anchor
        create_badge_icon(
            anchor,
            kind,
            white,
            blue_mark,
            badge_materials[kind],
            tiktok_cyan,
            tiktok_red,
        )
        for frame, lift, turn in ((1, 0.0, -1.0), (120, bob, 1.0), (FRAME_END, 0.0, -1.0)):
            anchor.location = (base_location[0], base_location[1], base_location[2] + lift)
            anchor.rotation_euler = (0.0, 0.0, base_rotation + math.radians(1.6 * turn))
            anchor.keyframe_insert(data_path="location", frame=frame)
            anchor.keyframe_insert(data_path="rotation_euler", frame=frame)

    core.location = (0.0, 0.0, -0.08)
    core.rotation_euler = (math.radians(4.5), math.radians(-8), math.radians(-5.5))
    core.keyframe_insert(data_path="location", frame=1)
    core.keyframe_insert(data_path="rotation_euler", frame=1)
    core.location.z = 0.12
    core.rotation_euler = (math.radians(2), math.radians(-3.5), math.radians(-3.5))
    core.keyframe_insert(data_path="location", frame=120)
    core.keyframe_insert(data_path="rotation_euler", frame=120)
    core.location = (0.0, 0.0, -0.08)
    core.rotation_euler = (math.radians(4.5), math.radians(-8), math.radians(-5.5))
    core.keyframe_insert(data_path="location", frame=FRAME_END)
    core.keyframe_insert(data_path="rotation_euler", frame=FRAME_END)

    camera_data = bpy.data.cameras.new("Hero Camera")
    camera = bpy.data.objects.new("Hero Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (0.0, -25.5, 1.3)
    camera.data.lens = 55
    look_at(camera, (0.0, 0.0, 0.15))
    bpy.context.scene.camera = camera

    def add_area(name: str, location: tuple[float, float, float], energy: float, size: float, color: tuple[float, float, float], target: tuple[float, float, float] = (0, 0, 0)) -> None:
        data = bpy.data.lights.new(name, type="AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = location
        look_at(obj, target)

    add_area("Key light", (-6.5, -9.0, 8.0), 1350, 6.0, (0.78, 0.88, 1.0))
    add_area("Rim light", (7.0, 1.5, 5.5), 1150, 5.0, (0.22, 0.45, 1.0))
    add_area("Soft fill", (2.0, -7.5, -5.5), 900, 5.0, (0.55, 0.72, 1.0))

    world = bpy.data.worlds.new("Aurora studio")
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.018, 0.028, 0.07, 1.0)
    background.inputs["Strength"].default_value = 0.35
    bpy.context.scene.world = world

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = FRAME_END
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.filepath = str(POSTER_PATH)
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.fps = 30

    scene.frame_set(24)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    bpy.ops.render.render(write_still=True)
    scene.frame_set(1)

    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        export_animations=True,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_apply=False,
    )
    print(f"Created {BLEND_PATH}")
    print(f"Created {GLB_PATH}")
    print(f"Created {POSTER_PATH}")


if __name__ == "__main__":
    build_scene()
