import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())
// jsdom has no scrollTo on elements
Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo
