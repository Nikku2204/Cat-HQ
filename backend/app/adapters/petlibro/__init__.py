# Petlibro PLAF103 adapter package.
#
# client.py is a GPL-3.0-or-later port from jjjonesjr33/petlibro (see the
# header in that file and LICENSE in this directory). adapter.py glues it
# into Cat HQ's DeviceAdapter interface.
from .adapter import PetlibroAdapter

__all__ = ["PetlibroAdapter"]
