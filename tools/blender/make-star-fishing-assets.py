# Build the star-fishing GLB demo assets (headless Blender 5.2.3).
#   star-fish.glb    — big gold fish (replaces the primitive for fish-5)
#   star-trophy.glb  — gold 5-point star, floats above the dock end
# Run: ~/workspace/tools/blender/blender -b --python tools/blender/make-star-fishing-assets.py
import bpy
import math
import os

OUT_DIR = "/home/hatch/workspace/aldol-engine-step0/m1/games/star-fishing/assets/models"
os.makedirs(OUT_DIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, metallic=0.6, roughness=0.35, emission=None, emission_strength=0.6):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return m


def add_sphere(name, loc, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    return o


def add_cone(name, loc, radius, depth, rot, mat):
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=radius, radius2=0.0, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o


def export_selected(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True)
    print("EXPORTED", path, os.path.getsize(path), "bytes")


# --- star-fish ---
gold = make_material("Gold", (1.0, 0.8, 0.2))
dark = make_material("Dark", (0.1, 0.1, 0.1), metallic=0.0, roughness=0.6)
parts = [
    add_sphere("fish-body", (0, 0, 0), (0.55, 0.22, 0.28), gold),
    add_cone("fish-tail", (-0.75, 0, 0), 0.28, 0.5, (0, math.radians(90), 0), gold),
    add_cone("fish-fin", (0, 0.22, 0), 0.14, 0.3, (0, 0, 0), gold),
    add_sphere("fish-eye-l", (0.32, 0.08, -0.12), (0.05, 0.05, 0.05), dark),
    add_sphere("fish-eye-r", (0.32, 0.08, 0.12), (0.05, 0.05, 0.05), dark),
]
bpy.ops.object.select_all(action="DESELECT")
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
fish = bpy.context.active_object
fish.name = "star-fish"
export_selected(os.path.join(OUT_DIR, "star-fish.glb"))
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()


# --- star-trophy (5-point star, extruded) ---
def make_star(name, outer=0.6, inner=0.26, depth=0.18, mat=None):
    rim = []
    for i in range(10):
        r = outer if i % 2 == 0 else inner
        a = math.pi / 2 + i * math.pi / 5
        rim.append((r * math.cos(a), r * math.sin(a)))
    verts = (
        [(0, 0, depth / 2)]
        + [(x, y, depth / 2) for x, y in rim]
        + [(0, 0, -depth / 2)]
        + [(x, y, -depth / 2) for x, y in rim]
    )
    faces = []
    for i in range(10):
        j = (i + 1) % 10
        faces.append((0, 1 + i, 1 + j))            # front fan (+Z)
        faces.append((11, 12 + j, 12 + i))         # back fan (-Z)
        faces.append((1 + i, 12 + i, 12 + j, 1 + j))  # side quad
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj


star_mat = make_material("StarGold", (1.0, 0.85, 0.25), metallic=0.5, roughness=0.3,
                         emission=(1.0, 0.8, 0.2), emission_strength=0.6)
star = make_star("star-trophy", mat=star_mat)
bpy.ops.object.select_all(action="DESELECT")
star.select_set(True)
bpy.context.view_layer.objects.active = star
export_selected(os.path.join(OUT_DIR, "star-trophy.glb"))
print("DONE")
