import copy
import unittest
import server


class LibraryFormatTests(unittest.TestCase):
    def document(self):
        return {"figure_types": [{"figure_type_id": 1}, {"figure_type_id": 2}],
                "keyframes": [{"objects": [{"figure_type_id": 1, "join": None},
                                            {"figure_type_id": 2, "join": {"target_object_slot": 0}}]}],
                "backgrounds": [], "_styk": {"libraryKind": "set"}}

    def test_set_is_a_single_self_contained_pose(self):
        server.validate_native_figure(self.document())

    def test_rejects_external_joins_or_scene_animation(self):
        document = self.document()
        for slot in (-1, 2, True, "0"):
            bad = copy.deepcopy(document)
            bad["keyframes"][0]["objects"][1]["join"]["target_object_slot"] = slot
            with self.assertRaises(server.ApiError):
                server.validate_native_figure(bad)
        for key in ("animation", "layerSheet", "simpleFrameDraft"):
            bad = copy.deepcopy(document)
            bad["_styk"][key] = {"version": 1}
            with self.assertRaises(server.ApiError):
                server.validate_native_figure(bad)

    def test_movieclip_extension_still_requires_one_movieclip(self):
        with self.assertRaises(server.ApiError):
            server.validate_native_figure(self.document(), "stykmov")
        document = self.document()
        document["figure_types"] = [{"figure_type_id": 1, "_styk": {"movieclip": {"version": 1}}}]
        document["keyframes"][0]["objects"] = [{"figure_type_id": 1, "join": None}]
        server.validate_native_figure(document, "stykmov")


if __name__ == '__main__':
    unittest.main()
