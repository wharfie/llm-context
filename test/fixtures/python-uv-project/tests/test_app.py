import unittest

from uv_app import message


class AppTest(unittest.TestCase):
    def test_message(self):
        self.assertEqual(message(), 'app -> hello from wheel')


if __name__ == '__main__':
    unittest.main()
